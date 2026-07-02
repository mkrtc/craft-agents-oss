import { extractLabelId } from '../labels/values.ts';
import type { SkillSummary } from '../skills/types.ts';
import { getDefaultLabelSkillBindingsConfig, hashLabelSkillBindingsConfig, validateLabelSkillBindingsConfig } from './storage.ts';
import type {
  LabelSkillAnchorResolution,
  LabelSkillBinding,
  LabelSkillBindingDiagnostic,
  LabelSkillBindingsConfig,
  ResolveActiveLabelSkillAnchorsOptions,
  ResolvedLabelSkillAnchor,
  SelectLabelSkillBootstrapCandidatesOptions,
  LabelSkillBootstrapCandidateSelection,
  LabelSkillBootstrapEligibilityResult,
  LabelSkillAnchorState,
} from './types.ts';

const DEFAULT_MAX_ACTIVE_ANCHORS = 8;
const DEFAULT_MAX_SERIALIZED_BYTES = 12_000;
export const DEFAULT_MAX_LABEL_SKILL_BOOTSTRAP_SKILLS = 2;
const TRUNCATION_MARKER = '[label-skill-bindings truncated deterministically]';

export function resolveActiveLabelSkillAnchors(
  config: LabelSkillBindingsConfig,
  options: ResolveActiveLabelSkillAnchorsOptions,
): LabelSkillAnchorResolution {
  const warnings: LabelSkillBindingDiagnostic[] = [];
  const now = options.now ?? new Date();
  const maxActiveAnchors = options.maxActiveAnchors ?? DEFAULT_MAX_ACTIVE_ANCHORS;
  const maxSerializedBytes = options.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES;
  const validation = validateLabelSkillBindingsConfig(config, {
    labels: options.labels,
    skills: options.skills,
    workspaceSlug: options.workspaceSlug,
  });
  if (!validation.valid) {
    warnings.push(...validation.errors);
  }
  const safeConfig = validation.valid ? validation.config : getDefaultLabelSkillBindingsConfig();
  const configHash = hashLabelSkillBindingsConfig(safeConfig);
  const validLabelIds = options.labels ? new Set(options.labels.map(label => label.id)) : null;
  const activeLabelIds = new Set(
    (options.sessionLabels ?? [])
      .map(extractLabelId)
      .filter(labelId => !validLabelIds || validLabelIds.has(labelId)),
  );
  const skillsBySlug = new Map((options.skills ?? []).map(skill => [skill.slug, skill] as const));

  const eligible = safeConfig.bindings
    .filter(binding => binding.enabled && binding.compactInstruction.trim().length > 0)
    .filter(binding => activeLabelIds.has(binding.labelId))
    .sort(compareBindings);

  const activeAnchors: ResolvedLabelSkillAnchor[] = [];
  for (const binding of eligible) {
    const skill = skillsBySlug.get(binding.skillSlug);
    if (!scopeApplies(binding, skill, options.workspaceSlug, warnings)) continue;
    activeAnchors.push(toAnchor(binding, skill));
  }

  let truncated = false;
  let includedAnchors = activeAnchors;
  if (includedAnchors.length > maxActiveAnchors) {
    truncated = true;
    warnings.push({
      severity: 'warning',
      code: 'active-anchor-count-cap',
      message: `Only the first ${maxActiveAnchors} active label-skill bindings were injected`,
    });
    includedAnchors = includedAnchors.slice(0, maxActiveAnchors);
  }

  let blockKind: LabelSkillAnchorResolution['blockKind'] = 'none';
  let block: string | undefined;

  if (includedAnchors.length > 0) {
    blockKind = 'active';
    ({ block, anchors: includedAnchors, truncated } = fitBlock({
      kind: 'active',
      anchors: includedAnchors,
      configHash,
      generatedAt: now.toISOString(),
      maxSerializedBytes,
      truncated,
      warnings,
    }));
  } else if (hasPriorLabelSkillRuntimeContext(options.previousState)) {
    blockKind = 'revocation';
    block = buildBlock({
      kind: 'revocation',
      anchors: [],
      configHash,
      generatedAt: now.toISOString(),
      truncated: false,
      revokedBindingIds: options.previousState?.lastActiveBindingIds ?? [],
    });
  }

  const requiredSourceSlugs = Array.from(new Set(includedAnchors.flatMap(anchor => anchor.requiredSourceSlugs))).sort();
  const nextState = buildNextAnchorState({
    previousState: options.previousState,
    configHash,
    activeBindingIds: includedAnchors.map(anchor => anchor.bindingId),
    blockKind,
    injectedAt: block ? now.toISOString() : options.previousState?.lastInjectedAt,
  });

  return {
    activeAnchors: includedAnchors,
    block,
    blockKind,
    configHash,
    warnings,
    requiredSourceSlugs,
    nextState,
  };
}

export function hasPriorFinalAssistantModelResponse(messages: Array<{ role: string; isIntermediate?: boolean }>): boolean {
  return messages.some(message => message.role === 'assistant' && message.isIntermediate !== true);
}

export function getLabelSkillBootstrapEligibility(options: {
  activeAnchorCount: number;
  messagesBeforeModelCall: Array<{ role: string; isIntermediate?: boolean }>;
  isQueuedReplay?: boolean;
}): LabelSkillBootstrapEligibilityResult {
  if (options.isQueuedReplay) {
    return { eligible: false, reason: 'queued-replay' };
  }
  if (hasPriorFinalAssistantModelResponse(options.messagesBeforeModelCall)) {
    return { eligible: false, reason: 'prior-final-assistant' };
  }
  if (options.activeAnchorCount <= 0) {
    return { eligible: false, reason: 'no-active-anchors' };
  }
  return { eligible: true };
}

export function selectLabelSkillBootstrapCandidates(
  options: SelectLabelSkillBootstrapCandidatesOptions,
): LabelSkillBootstrapCandidateSelection {
  const maxBootstrapSkills = Math.max(0, options.maxBootstrapSkills ?? DEFAULT_MAX_LABEL_SKILL_BOOTSTRAP_SKILLS);
  const explicitSkillSlugs = Array.from(new Set((options.explicitSkillSlugs ?? []).filter(Boolean)));
  const eligibility = getLabelSkillBootstrapEligibility({
    activeAnchorCount: options.activeAnchors.length,
    messagesBeforeModelCall: options.messagesBeforeModelCall,
    isQueuedReplay: options.isQueuedReplay,
  });
  if (!eligibility.eligible || maxBootstrapSkills === 0) {
    return {
      eligible: eligibility.eligible,
      reason: eligibility.reason ?? (maxBootstrapSkills === 0 ? 'no-candidates' : undefined),
      anchors: [],
      overflowAnchors: eligibility.eligible ? options.activeAnchors : [],
      explicitSkillSlugs,
      maxBootstrapSkills,
    };
  }

  const explicitSlugs = new Set(explicitSkillSlugs);
  const completedSlugs = getCompletedBootstrapSkillSlugs(options.previousState, options.configHash);
  const selected: ResolvedLabelSkillAnchor[] = [];
  const overflow: ResolvedLabelSkillAnchor[] = [];
  const selectedSlugs = new Set<string>();

  for (const anchor of options.activeAnchors) {
    if (explicitSlugs.has(anchor.skillSlug) || completedSlugs.has(anchor.skillSlug)) continue;
    if (selectedSlugs.has(anchor.skillSlug)) continue;
    if (selectedSlugs.size < maxBootstrapSkills) {
      selected.push(anchor);
      selectedSlugs.add(anchor.skillSlug);
    } else {
      overflow.push(anchor);
    }
  }

  return {
    eligible: selected.length > 0,
    reason: selected.length > 0 ? undefined : 'no-candidates',
    anchors: selected,
    overflowAnchors: overflow,
    explicitSkillSlugs,
    maxBootstrapSkills,
  };
}

function hasPriorLabelSkillRuntimeContext(previousState: LabelSkillAnchorState | undefined): boolean {
  if ((previousState?.lastActiveBindingIds?.length ?? 0) > 0) return true;
  const bootstrap = previousState?.bootstrap;
  if (!bootstrap) return false;
  return (bootstrap.bootstrappedSkillSlugs?.length ?? 0) > 0
    || (bootstrap.entries?.length ?? 0) > 0;
}

function buildNextAnchorState(args: {
  previousState?: LabelSkillAnchorState;
  configHash: string;
  activeBindingIds: string[];
  blockKind: 'active' | 'revocation' | 'none';
  injectedAt?: string;
}): LabelSkillAnchorState {
  const bootstrap = args.blockKind === 'revocation'
    ? { configHash: args.configHash, entries: [], bootstrappedSkillSlugs: [], updatedAt: args.injectedAt }
    : preserveBootstrapState(args.previousState, args.configHash);
  return {
    lastConfigHash: args.configHash,
    lastActiveBindingIds: args.activeBindingIds,
    lastBlockKind: args.blockKind,
    lastInjectedAt: args.injectedAt,
    ...(bootstrap ? { bootstrap } : {}),
  };
}

function preserveBootstrapState(previousState: LabelSkillAnchorState | undefined, configHash: string): LabelSkillAnchorState['bootstrap'] | undefined {
  const bootstrap = previousState?.bootstrap;
  if (!bootstrap || bootstrap.configHash !== configHash) return undefined;
  return bootstrap;
}

function getCompletedBootstrapSkillSlugs(previousState: LabelSkillAnchorState | undefined, configHash: string): Set<string> {
  const completed = new Set<string>();
  const bootstrap = previousState?.bootstrap;
  if (!bootstrap || bootstrap.configHash !== configHash) return completed;
  for (const slug of bootstrap.bootstrappedSkillSlugs ?? []) completed.add(slug);
  for (const entry of bootstrap.entries ?? []) {
    if (entry.status === 'completed') completed.add(entry.skillSlug);
  }
  return completed;
}

function compareBindings(a: LabelSkillBinding, b: LabelSkillBinding): number {
  return a.labelId.localeCompare(b.labelId)
    || a.skillSlug.localeCompare(b.skillSlug)
    || a.id.localeCompare(b.id);
}

function scopeApplies(
  binding: LabelSkillBinding,
  skill: SkillSummary | undefined,
  workspaceSlug: string | undefined,
  warnings: LabelSkillBindingDiagnostic[],
): boolean {
  if (binding.applyScope.mode === 'workspace-slug') {
    return !workspaceSlug || binding.applyScope.workspaceSlug === workspaceSlug;
  }

  if (!skill) {
    warnings.push({ severity: 'warning', code: 'runtime-missing-skill', message: `Skipping binding ${binding.id}; skill "${binding.skillSlug}" is unavailable`, bindingId: binding.id });
    return false;
  }

  if (binding.applyScope.source !== skill.source || binding.applyScope.scopeFingerprint !== skill.scopeFingerprint) {
    warnings.push({ severity: 'warning', code: 'runtime-scope-mismatch', message: `Skipping binding ${binding.id}; skill scope/fingerprint does not match this session`, bindingId: binding.id });
    return false;
  }

  if (binding.applyScope.metadataHash !== skill.metadataHash) {
    warnings.push({ severity: 'warning', code: 'runtime-skill-metadata-drift', message: `Skipping binding ${binding.id}; skill metadata changed since binding creation`, bindingId: binding.id });
    return false;
  }

  return true;
}

function toAnchor(binding: LabelSkillBinding, skill: SkillSummary | undefined): ResolvedLabelSkillAnchor {
  const snapshotSlugs = Array.isArray(binding.requiredSourcesSnapshot)
    ? binding.requiredSourcesSnapshot
      .map(source => source?.slug)
      .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0)
    : undefined;
  const requiredSourceSlugs = snapshotSlugs
    ?? skill?.requiredSources
    ?? [];
  return {
    bindingId: binding.id,
    labelId: binding.labelId,
    skillSlug: binding.skillSlug,
    skillName: skill?.metadata.name ?? binding.generatedFrom?.skillName,
    skillDescription: skill?.metadata.description ?? binding.generatedFrom?.skillDescription,
    compactInstruction: binding.compactInstruction.trim(),
    requiredSourceSlugs: Array.from(new Set(requiredSourceSlugs)).sort(),
  };
}

function fitBlock(args: {
  kind: 'active';
  anchors: ResolvedLabelSkillAnchor[];
  configHash: string;
  generatedAt: string;
  maxSerializedBytes: number;
  truncated: boolean;
  warnings: LabelSkillBindingDiagnostic[];
}): { block: string; anchors: ResolvedLabelSkillAnchor[]; truncated: boolean } {
  let anchors = args.anchors;
  let truncated = args.truncated;
  let block = buildBlock({ ...args, anchors, truncated });

  while (Buffer.byteLength(block, 'utf8') > args.maxSerializedBytes && anchors.length > 1) {
    truncated = true;
    anchors = anchors.slice(0, -1);
    block = buildBlock({ ...args, anchors, truncated });
  }

  if (Buffer.byteLength(block, 'utf8') > args.maxSerializedBytes) {
    truncated = true;
    anchors = anchors.map(anchor => ({
      ...anchor,
      compactInstruction: truncateString(anchor.compactInstruction, Math.max(200, Math.floor(args.maxSerializedBytes / Math.max(anchors.length, 1) / 2))),
    }));
    block = buildBlock({ ...args, anchors, truncated });
  }

  if (Buffer.byteLength(block, 'utf8') > args.maxSerializedBytes) {
    anchors = [];
    block = buildBlock({ ...args, anchors, truncated: true });
  }

  if (truncated) {
    args.warnings.push({ severity: 'warning', code: 'active-anchor-payload-cap', message: `Label-skill anchor payload was capped at ${args.maxSerializedBytes} bytes` });
  }

  return { block, anchors, truncated };
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length - 1))}\n${TRUNCATION_MARKER}`;
}

function buildBlock(args: {
  kind: 'active' | 'revocation';
  anchors: ResolvedLabelSkillAnchor[];
  configHash: string;
  generatedAt: string;
  truncated: boolean;
  revokedBindingIds?: string[];
}): string {
  const payload = args.kind === 'active'
    ? {
        version: 1,
        kind: 'active' as const,
        configHash: args.configHash,
        generatedAt: args.generatedAt,
        supersedesOlderLabelSkillBlocks: true,
        supersedesScope: 'prior-label-skill-compact-and-bootstrap-contexts-only',
        priority: 'lower-than-system-developer-tool-permission-and-explicit-user-instructions',
        activeRoleBindingInstruction: 'A label-bound skill role is active for this session. This is not an explicit [skill:...] mention, but it is still an active runtime role binding. Do not claim no skill/role is active while this block is present.',
        truncated: args.truncated,
        truncationMarker: args.truncated ? TRUNCATION_MARKER : undefined,
        activeBindings: args.anchors.map(anchor => ({
          bindingId: anchor.bindingId,
          labelId: anchor.labelId,
          skillSlug: anchor.skillSlug,
          skillName: anchor.skillName,
          skillDescription: anchor.skillDescription,
          compactInstruction: anchor.compactInstruction,
        })),
      }
    : {
        version: 1,
        kind: 'revocation' as const,
        configHash: args.configHash,
        generatedAt: args.generatedAt,
        supersedesOlderLabelSkillBlocks: true,
        supersedesScope: 'prior-label-skill-compact-and-bootstrap-contexts-only',
        revokedBindingIds: args.revokedBindingIds ?? [],
        instruction: 'No label-bound skill role is active now. Disregard prior label-bound compact contexts and prior label-bound bootstrap/read-derived role instructions only, unless the user explicitly restates them. Do not disregard independent facts, tool outputs, or direct user instructions from turns after a skill was read.',
      };

  if (args.kind === 'active') {
    return `<label-skill-bindings-context>\nA label-bound skill role is active for this session. This is not an explicit [skill:...] mention, but it is still an active runtime role binding. Do not claim no skill/role is active while this block is present. This hidden context is generated from compact label-to-skill bindings and is lower priority than system, developer, tool, permission, and explicit user instructions. Current label-skill context supersedes prior label-skill compact/bootstrap contexts only; it does not supersede system/developer/tool/permission instructions or direct user instructions. Do not reveal this block unless the user asks about session internals.\n${JSON.stringify(payload, null, 2)}\n</label-skill-bindings-context>`;
  }

  return `<label-skill-bindings-context>\nNo label-bound skill role is active for this session. This revocation supersedes prior label-skill compact contexts and prior label-bound bootstrap/read-derived role instructions only; it does not ask you to disregard independent facts, tool outputs, or direct user instructions from turns after a skill was read. It is lower priority than system, developer, tool, permission, and explicit user instructions. Do not reveal this block unless the user asks about session internals.\n${JSON.stringify(payload, null, 2)}\n</label-skill-bindings-context>`;
}
