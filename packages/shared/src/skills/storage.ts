/**
 * Skills Storage
 *
 * CRUD operations for workspace skills.
 * Skills are stored in {workspace}/skills/{slug}/ directories.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { basename, join } from 'path';
import matter from 'gray-matter';
import type { LoadedSkill, SkillMetadata, SkillPathSummary, SkillSource, SkillSummary } from './types.ts';
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import {
  validateIconValue,
  findIconFile,
  downloadIcon,
  needsIconDownload,
  isIconUrl,
} from '../utils/icon.ts';

// ============================================================
// Agent Skills Paths (Issue #171)
// ============================================================

/** Global agent skills directory: ~/.agents/skills/ */
export const GLOBAL_AGENT_SKILLS_DIR = join(homedir(), '.agents', 'skills');

/** Project-level agent skills relative directory name */
export const PROJECT_AGENT_SKILLS_DIR = '.agents/skills';

/**
 * Normalize requiredSources frontmatter to a clean string array.
 * Accepts a single string or array of strings, trims whitespace, and deduplicates.
 */
function normalizeRequiredSources(value: unknown): string[] | undefined {
  const asArray = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value
      : undefined;

  if (!asArray) return undefined;

  const normalized = Array.from(new Set(
    asArray
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(Boolean)
  ));

  return normalized.length > 0 ? normalized : undefined;
}

// ============================================================
// Parsing
// ============================================================

/**
 * Parse SKILL.md content and extract frontmatter + body
 */
function parseSkillFile(content: string): { metadata: SkillMetadata; body: string } | null {
  try {
    const parsed = matter(content);
    const metadata = parseSkillMetadata(parsed.data);
    if (!metadata) return null;

    return {
      metadata,
      body: parsed.content,
    };
  } catch {
    return null;
  }
}

function parseSkillMetadata(data: Record<string, unknown>): SkillMetadata | null {
  // Validate required fields
  if (typeof data.name !== 'string' || typeof data.description !== 'string') {
    return null;
  }

  // Validate and extract optional icon field
  // Only accepts emoji or URL - rejects inline SVG and relative paths
  const icon = validateIconValue(data.icon, 'Skills');

  return {
    name: data.name,
    description: data.description,
    globs: Array.isArray(data.globs) ? data.globs as string[] : undefined,
    alwaysAllow: Array.isArray(data.alwaysAllow) ? data.alwaysAllow as string[] : undefined,
    icon,
    requiredSources: normalizeRequiredSources(data.requiredSources),
  };
}

const MAX_SKILL_FRONTMATTER_BYTES = 64 * 1024;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readSkillFrontmatter(skillFile: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(skillFile, 'r');
    const buffer = Buffer.alloc(MAX_SKILL_FRONTMATTER_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    const match = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
    return match ? match[0] : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

function parseSkillMetadataFile(skillFile: string): { metadata: SkillMetadata; rawFrontmatter: string } | null {
  const rawFrontmatter = readSkillFrontmatter(skillFile);
  if (!rawFrontmatter) return null;

  try {
    const parsed = matter(rawFrontmatter);
    const metadata = parseSkillMetadata(parsed.data);
    if (!metadata) return null;
    return { metadata, rawFrontmatter };
  } catch {
    return null;
  }
}

function buildScopeLabel(source: SkillSource, projectRoot?: string): string {
  if (source === 'global') return 'Global';
  if (source === 'workspace') return 'Workspace';
  return projectRoot ? `Project: ${basename(projectRoot)}` : 'Project';
}

function buildScopeFingerprint(source: SkillSource, workspaceRoot: string, projectRoot?: string): string {
  if (source === 'global') return `global:${hashString(GLOBAL_AGENT_SKILLS_DIR)}`;
  if (source === 'workspace') return `workspace:${hashString(workspaceRoot)}`;
  return `project:${hashString(projectRoot ?? workspaceRoot)}`;
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single skill from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param slug - Skill directory name
 * @param source - Where this skill is loaded from
 */
function loadSkillFromDir(skillsDir: string, slug: string, source: SkillSource): LoadedSkill | null {
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  // Check directory exists
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    return null;
  }

  // Check SKILL.md exists
  if (!existsSync(skillFile)) {
    return null;
  }

  // Read and parse SKILL.md
  let content: string;
  try {
    content = readFileSync(skillFile, 'utf-8');
  } catch {
    return null;
  }

  const parsed = parseSkillFile(content);
  if (!parsed) {
    return null;
  }

  return {
    slug,
    metadata: parsed.metadata,
    content: parsed.body,
    iconPath: findIconFile(skillDir),
    path: skillDir,
    source,
  };
}

function loadSkillSummaryFromDir(
  skillsDir: string,
  slug: string,
  source: SkillSource,
  workspaceRoot: string,
  projectRoot?: string,
  options?: { includeContentHash?: boolean }
): SkillPathSummary | null {
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory() || !existsSync(skillFile)) {
    return null;
  }

  const parsed = parseSkillMetadataFile(skillFile);
  if (!parsed) return null;

  let contentHash: string | undefined;
  if (options?.includeContentHash) {
    try {
      contentHash = hashString(readFileSync(skillFile, 'utf-8'));
    } catch {
      contentHash = undefined;
    }
  }

  return {
    slug,
    metadata: parsed.metadata,
    source,
    metadataHash: hashString(stableStringify(parsed.metadata)),
    contentHash,
    scopeLabel: buildScopeLabel(source, projectRoot),
    scopeFingerprint: buildScopeFingerprint(source, workspaceRoot, projectRoot),
    requiredSources: parsed.metadata.requiredSources,
    path: skillDir,
    skillFilePath: skillFile,
  };
}

/**
 * Load all skills from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param source - Where these skills are loaded from
 */
function loadSkillsFromDir(skillsDir: string, source: SkillSource): LoadedSkill[] {
  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: LoadedSkill[] = [];

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skill = loadSkillFromDir(skillsDir, entry.name, source);
      if (skill) {
        skills.push(skill);
      }
    }
  } catch {
    // Ignore errors reading skills directory
  }

  return skills;
}

/**
 * Load a single skill from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function loadSkill(workspaceRoot: string, slug: string): LoadedSkill | null {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  return loadSkillFromDir(skillsDir, slug, 'workspace');
}

/**
 * Load all skills from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 */
export function loadWorkspaceSkills(workspaceRoot: string): LoadedSkill[] {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  return loadSkillsFromDir(skillsDir, 'workspace');
}

// ── Skills cache ────────────────────────────────────────────────────────
// loadAllSkills reads from up to 3 directories on every call (~100ms).
// The result rarely changes during a session, so we cache it per
// (workspaceRoot, projectRoot) pair with a 5-minute safety TTL.

const skillsCache = new Map<string, { skills: LoadedSkill[]; ts: number }>();
const skillSummariesCache = new Map<string, { summaries: SkillPathSummary[]; ts: number }>();
const SKILLS_CACHE_TTL = 5 * 60_000; // 5 minutes

/** Invalidate the skills cache (call on working dir change or skill file events). */
export function invalidateSkillsCache(): void {
  skillsCache.clear();
  skillSummariesCache.clear();
}

/**
 * Load all skills from all sources (global, workspace, project)
 * Skills with the same slug are overridden by higher-priority sources.
 * Priority: global (lowest) < workspace < project (highest)
 *
 * Results are cached per (workspaceRoot, projectRoot) pair. Call
 * invalidateSkillsCache() on working directory changes or skill file events.
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param projectRoot - Optional project root (working directory) for project-level skills
 */
export function loadAllSkills(workspaceRoot: string, projectRoot?: string): LoadedSkill[] {
  const cacheKey = `${workspaceRoot}::${projectRoot ?? ''}`;
  const now = Date.now();
  const cached = skillsCache.get(cacheKey);
  if (cached && now - cached.ts < SKILLS_CACHE_TTL) {
    return cached.skills;
  }

  const skillsBySlug = new Map<string, LoadedSkill>();

  // 1. Global skills (lowest priority): ~/.agents/skills/
  for (const skill of loadSkillsFromDir(GLOBAL_AGENT_SKILLS_DIR, 'global')) {
    skillsBySlug.set(skill.slug, skill);
  }

  // 2. Workspace skills (medium priority)
  for (const skill of loadWorkspaceSkills(workspaceRoot)) {
    skillsBySlug.set(skill.slug, skill);
  }

  // 3. Project skills (highest priority): {projectRoot}/.agents/skills/
  if (projectRoot) {
    const projectSkillsDir = join(projectRoot, PROJECT_AGENT_SKILLS_DIR);
    for (const skill of loadSkillsFromDir(projectSkillsDir, 'project')) {
      skillsBySlug.set(skill.slug, skill);
    }
  }

  const result = Array.from(skillsBySlug.values());
  skillsCache.set(cacheKey, { skills: result, ts: now });
  return result;
}

function listSkillSummariesFromDir(
  skillsDir: string,
  source: SkillSource,
  workspaceRoot: string,
  projectRoot?: string,
  options?: { includeContentHash?: boolean }
): SkillPathSummary[] {
  if (!existsSync(skillsDir)) return [];

  const summaries: SkillPathSummary[] = [];
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const summary = loadSkillSummaryFromDir(skillsDir, entry.name, source, workspaceRoot, projectRoot, options);
      if (summary) summaries.push(summary);
    }
  } catch {
    // Ignore errors reading skills directory
  }
  return summaries;
}

/**
 * List display-safe metadata-only skills from all sources (global < workspace < project).
 * Does not read full SKILL.md bodies unless includeContentHash is explicitly true.
 */
export function listSkillSummaries(
  workspaceRoot: string,
  projectRoot?: string,
  options?: { includeContentHash?: boolean; includeInternalPaths?: false }
): SkillSummary[];
export function listSkillSummaries(
  workspaceRoot: string,
  projectRoot: string | undefined,
  options: { includeContentHash?: boolean; includeInternalPaths: true }
): SkillPathSummary[];
export function listSkillSummaries(
  workspaceRoot: string,
  projectRoot?: string,
  options?: { includeContentHash?: boolean; includeInternalPaths?: boolean }
): Array<SkillSummary | SkillPathSummary> {
  const cacheKey = `${workspaceRoot}::${projectRoot ?? ''}::${options?.includeContentHash ? 'content' : 'metadata'}`;
  const now = Date.now();
  if (!options?.includeContentHash) {
    const cached = skillSummariesCache.get(cacheKey);
    if (cached && now - cached.ts < SKILLS_CACHE_TTL) {
      return options?.includeInternalPaths ? cached.summaries : cached.summaries.map(stripSkillSummaryPaths);
    }
  }

  const summariesBySlug = new Map<string, SkillPathSummary>();

  for (const summary of listSkillSummariesFromDir(GLOBAL_AGENT_SKILLS_DIR, 'global', workspaceRoot, projectRoot, options)) {
    summariesBySlug.set(summary.slug, summary);
  }

  for (const summary of listSkillSummariesFromDir(getWorkspaceSkillsPath(workspaceRoot), 'workspace', workspaceRoot, projectRoot, options)) {
    summariesBySlug.set(summary.slug, summary);
  }

  if (projectRoot) {
    const projectSkillsDir = join(projectRoot, PROJECT_AGENT_SKILLS_DIR);
    for (const summary of listSkillSummariesFromDir(projectSkillsDir, 'project', workspaceRoot, projectRoot, options)) {
      summariesBySlug.set(summary.slug, summary);
    }
  }

  const result = Array.from(summariesBySlug.values());
  if (!options?.includeContentHash) {
    skillSummariesCache.set(cacheKey, { summaries: result, ts: now });
  }
  return options?.includeInternalPaths ? result : result.map(stripSkillSummaryPaths);
}

function stripSkillSummaryPaths(summary: SkillPathSummary): SkillSummary {
  const { path: _path, skillFilePath: _skillFilePath, ...safe } = summary;
  return safe;
}

/**
 * Load one metadata-only skill summary by slug using project > workspace > global priority.
 * Does not read the full SKILL.md body unless includeContentHash is explicitly true.
 */
export function loadSkillSummaryBySlug(
  workspaceRoot: string,
  slug: string,
  projectRoot?: string,
  options?: { includeContentHash?: boolean; includeInternalPaths?: false }
): SkillSummary | null;
export function loadSkillSummaryBySlug(
  workspaceRoot: string,
  slug: string,
  projectRoot: string | undefined,
  options: { includeContentHash?: boolean; includeInternalPaths: true }
): SkillPathSummary | null;
export function loadSkillSummaryBySlug(
  workspaceRoot: string,
  slug: string,
  projectRoot?: string,
  options?: { includeContentHash?: boolean; includeInternalPaths?: boolean }
): SkillSummary | SkillPathSummary | null {
  if (projectRoot) {
    const projectSkillsDir = join(projectRoot, PROJECT_AGENT_SKILLS_DIR);
    const summary = loadSkillSummaryFromDir(projectSkillsDir, slug, 'project', workspaceRoot, projectRoot, options);
    if (summary) return options?.includeInternalPaths ? summary : stripSkillSummaryPaths(summary);
  }

  const workspaceSummary = loadSkillSummaryFromDir(getWorkspaceSkillsPath(workspaceRoot), slug, 'workspace', workspaceRoot, projectRoot, options);
  if (workspaceSummary) return options?.includeInternalPaths ? workspaceSummary : stripSkillSummaryPaths(workspaceSummary);

  const globalSummary = loadSkillSummaryFromDir(GLOBAL_AGENT_SKILLS_DIR, slug, 'global', workspaceRoot, projectRoot, options);
  if (globalSummary) return options?.includeInternalPaths ? globalSummary : stripSkillSummaryPaths(globalSummary);

  return null;
}

/** Resolve a SKILL.md path for explicit [skill:] invocation without reading the file body. */
export function resolveSkillFilePathBySlug(workspaceRoot: string, slug: string, projectRoot?: string): string | null {
  const summary = loadSkillSummaryBySlug(workspaceRoot, slug, projectRoot, { includeInternalPaths: true });
  return summary?.skillFilePath ?? null;
}

/**
 * Load a single skill by slug from all sources (project > workspace > global).
 * Unlike loadAllSkills(), this only reads the specific slug directory — O(1) not O(N).
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill slug to load
 * @param projectRoot - Optional project root for project-level skills
 */
export function loadSkillBySlug(workspaceRoot: string, slug: string, projectRoot?: string): LoadedSkill | null {
  // Highest priority: project-level
  if (projectRoot) {
    const projectSkillsDir = join(projectRoot, PROJECT_AGENT_SKILLS_DIR);
    const skill = loadSkillFromDir(projectSkillsDir, slug, 'project');
    if (skill) return skill;
  }

  // Medium priority: workspace
  const workspaceSkill = loadSkillFromDir(getWorkspaceSkillsPath(workspaceRoot), slug, 'workspace');
  if (workspaceSkill) return workspaceSkill;

  // Lowest priority: global
  return loadSkillFromDir(GLOBAL_AGENT_SKILLS_DIR, slug, 'global');
}

/**
 * Get icon path for a skill
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function getSkillIconPath(workspaceRoot: string, slug: string): string | null {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);

  if (!existsSync(skillDir)) {
    return null;
  }

  return findIconFile(skillDir) || null;
}

// ============================================================
// Delete Operations
// ============================================================

/**
 * Delete a skill from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function deleteSkill(workspaceRoot: string, slug: string): boolean {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);

  if (!existsSync(skillDir)) {
    return false;
  }

  try {
    rmSync(skillDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Check if a skill exists in a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function skillExists(workspaceRoot: string, slug: string): boolean {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  return existsSync(skillDir) && existsSync(skillFile);
}

/**
 * List skill slugs in a workspace
 * @param workspaceRoot - Absolute path to workspace root
 */
export function listSkillSlugs(workspaceRoot: string): string[] {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);

  if (!existsSync(skillsDir)) {
    return [];
  }

  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        const skillFile = join(skillsDir, entry.name, 'SKILL.md');
        return existsSync(skillFile);
      })
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// ============================================================
// Icon Download (uses shared utilities)
// ============================================================

/**
 * Download an icon from a URL and save it to the skill directory.
 * Returns the path to the downloaded icon, or null on failure.
 */
export async function downloadSkillIcon(
  skillDir: string,
  iconUrl: string
): Promise<string | null> {
  return downloadIcon(skillDir, iconUrl, 'Skills');
}

/**
 * Check if a skill needs its icon downloaded.
 * Returns true if metadata has a URL icon and no local icon file exists.
 */
export function skillNeedsIconDownload(skill: LoadedSkill): boolean {
  return needsIconDownload(skill.metadata.icon, skill.iconPath);
}

// Re-export icon utilities for convenience
export { isIconUrl } from '../utils/icon.ts';
