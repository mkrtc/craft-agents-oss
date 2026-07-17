/**
 * Config File Watcher
 *
 * Watches a fixed matrix of global/workspace control directories plus direct
 * source, skill, and session children. All observation is non-recursive and
 * leased through the process-wide DirectoryWatchBroker.
 */

import { existsSync, lstatSync, opendirSync, realpathSync, mkdirSync } from 'fs';
import { join, relative, resolve, isAbsolute } from 'path';
import { platform } from 'os';
import { CONFIG_DIR } from './paths.ts';
import { debug } from '../utils/debug.ts';
import { expandPath } from '../utils/paths.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { perf } from '../utils/perf.ts';
import { loadStoredConfig, type StoredConfig } from './storage.ts';
import {
  validateConfig,
  validatePreferences,
  validateSource,
  type ValidationResult,
} from './validators.ts';
import type { LoadedSource, SourceGuide } from '../sources/types.ts';
import {
  loadSource,
  loadWorkspaceSources,
  loadSourceGuide,
  sourceNeedsIconDownload,
  downloadSourceIcon,
} from '../sources/storage.ts';
import { permissionsConfigCache, getAppPermissionsDir } from '../agent/permissions-config.ts';
import {
  getWorkspacePath,
  getWorkspaceSourcesPath,
  getWorkspaceSkillsPath,
  getWorkspaceSessionsPath,
} from '../workspaces/storage.ts';
import type { LoadedSkill } from '../skills/types.ts';
import { loadSkill, loadAllSkills, invalidateSkillsCache, skillNeedsIconDownload, downloadSkillIcon } from '../skills/storage.ts';
import {
  loadStatusConfig,
  statusNeedsIconDownload,
  downloadStatusIcon,
} from '../statuses/storage.ts';
import { readSessionHeader } from '../sessions/jsonl.ts';
import type { SessionHeader } from '../sessions/types.ts';
import { AUTOMATIONS_CONFIG_FILE } from '../automations/constants.ts';
import { LABEL_SKILL_BINDINGS_FILE } from '../label-skill-bindings/types.ts';
import { loadAppTheme, loadPresetThemes, loadPresetTheme, getAppThemesDir } from './storage.ts';
import type { ThemeOverrides, PresetTheme } from './theme.ts';
import {
  DEFAULT_WATCH_DIRECTORY_CAPACITY,
  getProcessWatchBroker,
  type DirectoryWatchBroker,
  type DirectoryWatchLease,
  type DirectoryWatchRequest,
} from './watch-broker.ts';
import type {
  WatchBrokerSnapshot,
  WatchDiagnostic,
  WatchLeasePriority,
  WatchLeaseState,
  WatchPathClass,
} from './watch-diagnostics.ts';
import type { DirectoryWatchEvent } from './watch-adapter.ts';

// ============================================================
// Active Watcher Registry (duplicate detection)
// ============================================================

/**
 * Tracks active ConfigWatcher instances by canonical workspace directory.
 * Descriptor sharing itself is enforced by DirectoryWatchBroker; this registry
 * remains as a lightweight lifecycle/debugging aid.
 */
const activeWatchers = new Map<string, string>(); // canonical workspaceDir → first creator workspaceId
const activeWatcherCounts = new Map<string, number>();

/** Exported for testing only */
export function _getActiveWatchers(): ReadonlyMap<string, string> {
  return activeWatchers;
}

// ============================================================
// Constants
// ============================================================

const PREFERENCES_FILE = join(CONFIG_DIR, 'preferences.json');

// Debounce delay in milliseconds
const DEBOUNCE_MS = 100;
const MAX_DIRECT_CHILDREN_PER_SERVICE = DEFAULT_WATCH_DIRECTORY_CAPACITY;

// Longer debounce for session metadata on Windows where fs.watch() fires
// aggressively for atomic writes (unlink + rename = 2+ events)
const SESSION_META_DEBOUNCE_MS = platform() === 'win32' ? 300 : DEBOUNCE_MS;

// ============================================================
// Types
// ============================================================

/**
 * User preferences structure (mirrors UserPreferencesSchema)
 */
export interface UserPreferences {
  name?: string;
  timezone?: string;
  location?: {
    city?: string;
    region?: string;
    country?: string;
  };
  notes?: string;
  /** Internal: mirrors Appearance → Language. Maintained by the main-process i18n IPC handler. */
  uiLanguage?: string;
  updatedAt?: number;
}

/**
 * Callbacks for config changes
 */
export interface ConfigWatcherCallbacks {
  /** Called when config.json changes */
  onConfigChange?: (config: StoredConfig) => void;
  /** Called when preferences.json changes */
  onPreferencesChange?: (prefs: UserPreferences) => void;
  /** Called when LLM connections array changes (add/remove/update connections) */
  onLlmConnectionsChange?: (connections: import('./storage.ts').LlmConnection[]) => void;

  // Source callbacks
  /** Called when a specific source config changes (null if deleted) */
  onSourceChange?: (slug: string, source: LoadedSource | null) => void;
  /** Called when a source's guide.md changes */
  onSourceGuideChange?: (slug: string, guide: SourceGuide) => void;
  /** Called when the sources list changes (add/remove folders) */
  onSourcesListChange?: (sources: LoadedSource[]) => void;

  // Skill callbacks
  /** Called when a specific skill changes (null if deleted) */
  onSkillChange?: (slug: string, skill: LoadedSkill | null) => void;
  /** Called when the skills list changes (add/remove folders) */
  onSkillsListChange?: (skills: LoadedSkill[]) => void;

  // Permissions callbacks
  /** Called when app-level default permissions change (~/.craft-agent/permissions/default.json) */
  onDefaultPermissionsChange?: () => void;
  /** Called when workspace permissions.json changes */
  onWorkspacePermissionsChange?: (workspaceId: string) => void;
  /** Called when a source's permissions.json changes */
  onSourcePermissionsChange?: (sourceSlug: string) => void;

  // Status callbacks
  /** Called when statuses config.json changes */
  onStatusConfigChange?: (workspaceId: string) => void;
  /** Called when a status icon file changes */
  onStatusIconChange?: (workspaceId: string, iconFilename: string) => void;

  // Label callbacks
  /** Called when labels config.json changes */
  onLabelConfigChange?: (workspaceId: string) => void;
  /** Called when label-skill-bindings.json changes */
  onLabelSkillBindingsConfigChange?: (workspaceId: string) => void;

  // Automations callbacks
  /** Called when automations.json changes */
  onAutomationsConfigChange?: (workspaceId: string) => void;

  // Session callbacks
  /** Called when a session's JSONL header is modified externally (labels, name, flags, etc.) */
  onSessionMetadataChange?: (sessionId: string, header: SessionHeader) => void;

  // Theme callbacks (app-level only)
  /** Called when app-level theme.json changes */
  onAppThemeChange?: (theme: ThemeOverrides | null) => void;
  /** Called when a preset theme file changes (null if deleted) */
  onPresetThemeChange?: (themeId: string, theme: PresetTheme | null) => void;
  /** Called when the preset themes list changes (add/remove files) */
  onPresetThemesListChange?: (themes: PresetTheme[]) => void;

  // Error callbacks
  /** Called when a validation error occurs */
  onValidationError?: (file: string, result: ValidationResult) => void;
  /** Called when an error occurs reading/parsing a file */
  onError?: (file: string, error: Error) => void;
  /** Content-free descriptor/capacity/error telemetry. */
  onWatchDiagnostic?: (diagnostic: WatchDiagnostic) => void;
  /** Typed degraded/recovered state for one watched path class. */
  onWatchStateChange?: (state: WatchLeaseState) => void;
}

export interface ConfigWatcherOptions {
  broker?: DirectoryWatchBroker;
  /** Test-only global path overrides; production uses ~/.craft-agent paths. */
  globalConfigDir?: string;
  appThemesDir?: string;
  appPermissionsDir?: string;
}

// ============================================================
// Preferences Loading
// ============================================================

/**
 * Load preferences from file
 */
export function loadPreferences(): UserPreferences | null {
  if (!existsSync(PREFERENCES_FILE)) {
    return null;
  }

  try {
    return readJsonFileSync<UserPreferences>(PREFERENCES_FILE);
  } catch (error) {
    debug('[ConfigWatcher] Error loading preferences', error);
    return null;
  }
}

// ============================================================
// ConfigWatcher Class
// ============================================================

/**
 * Watches the fixed configuration matrix through process-wide broker leases.
 */
export class ConfigWatcher {
  private readonly workspaceId: string;
  private readonly callbacks: ConfigWatcherCallbacks;
  private readonly broker: DirectoryWatchBroker;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly controlLeases = new Map<WatchPathClass, DirectoryWatchLease>();
  private readonly sourceLeases = new Map<string, DirectoryWatchLease>();
  private readonly skillLeases = new Map<string, DirectoryWatchLease>();
  private readonly sessionLeases = new Map<string, DirectoryWatchLease>();
  private isRunning = false;
  private generation = 0;
  private registryKey = '';
  private registryRegistered = false;

  // Track known items for detecting adds/removes
  private readonly knownSources = new Set<string>();
  private readonly knownSkills = new Set<string>();
  private readonly knownSessions = new Set<string>();
  private readonly knownThemes = new Set<string>();

  // Track LLM connections for change detection (JSON string for deep comparison)
  private lastLlmConnectionsHash = '';

  // Computed paths
  private readonly workspaceDir: string;
  private readonly sourcesDir: string;
  private readonly skillsDir: string;
  private readonly sessionsDir: string;
  private readonly statusesDir: string;
  private readonly statusIconsDir: string;
  private readonly labelsDir: string;
  private readonly globalConfigDir: string;
  private readonly appThemesDir: string;
  private readonly appPermissionsDir: string;

  constructor(
    workspaceIdOrPath: string,
    callbacks: ConfigWatcherCallbacks,
    options: ConfigWatcherOptions = {},
  ) {
    this.callbacks = callbacks;
    this.broker = options.broker ?? getProcessWatchBroker();
    // Support both workspace ID and workspace root path.
    const isPath = workspaceIdOrPath.includes('/') || workspaceIdOrPath.includes('\\');
    if (isPath) {
      this.workspaceDir = expandPath(workspaceIdOrPath);
      this.workspaceId = workspaceIdOrPath.split(/[/\\]/).pop() || workspaceIdOrPath;
    } else {
      this.workspaceId = workspaceIdOrPath;
      this.workspaceDir = getWorkspacePath(workspaceIdOrPath);
    }
    this.sourcesDir = getWorkspaceSourcesPath(this.workspaceDir);
    this.skillsDir = getWorkspaceSkillsPath(this.workspaceDir);
    this.sessionsDir = getWorkspaceSessionsPath(this.workspaceDir);
    this.statusesDir = join(this.workspaceDir, 'statuses');
    this.statusIconsDir = join(this.statusesDir, 'icons');
    this.labelsDir = join(this.workspaceDir, 'labels');
    this.globalConfigDir = options.globalConfigDir ?? CONFIG_DIR;
    this.appThemesDir = options.appThemesDir ?? getAppThemesDir();
    this.appPermissionsDir = options.appPermissionsDir ?? getAppPermissionsDir();
  }

  getWorkspaceSlug(): string {
    return this.workspaceId;
  }

  getWatchSnapshot(): WatchBrokerSnapshot {
    return this.broker.getSnapshot();
  }

  /**
   * Start in two passes: acquire all shared/global and workspace controls as one
   * transaction, then request optional direct-child leases.
   */
  start(): void {
    if (this.isRunning) return;

    const span = perf.span('configWatcher.start', { workspaceId: this.workspaceId });
    const generation = ++this.generation;
    this.isRunning = true;

    try {
      this.ensureRequiredDirectories();
      span.mark('ensureDirectories');

      this.registryKey = this.canonicalWorkspaceKey();
      const existingOwner = activeWatchers.get(this.registryKey);
      if (existingOwner) {
        debug(`[ConfigWatcher] Sharing canonical workspace watch (existing: ${existingOwner}, new: ${this.workspaceId})`);
      }

      const requests = this.requiredWatchRequests(generation);
      const leases = this.broker.acquireRequired(requests);
      for (let index = 0; index < requests.length; index += 1) {
        this.controlLeases.set(requests[index]!.pathClass, leases[index]!);
      }
      if (!existingOwner) activeWatchers.set(this.registryKey, this.workspaceId);
      activeWatcherCounts.set(this.registryKey, (activeWatcherCounts.get(this.registryKey) ?? 0) + 1);
      this.registryRegistered = true;
      span.mark('requiredControls');

      // Dynamic children are intentionally second-pass and optional.
      this.scanSources(false);
      this.scanSkills(false);
      this.scanSessions(false);
      this.scanAppThemes();
      span.mark('optionalChildren');

      this.initLlmConnectionsHash();
      span.mark('initLlmConnectionsHash');
      debug('[ConfigWatcher] Started bounded directory observation');
      span.end();
    } catch (error) {
      this.stopInternal();
      span.end();
      throw error;
    }
  }

  private initLlmConnectionsHash(): void {
    const config = loadStoredConfig();
    if (config) {
      const connections = config.llmConnections || [];
      this.lastLlmConnectionsHash = JSON.stringify(connections);
    }
  }

  /**
   * Local SessionManager writes remain authoritative. This also closes the
   * create-directory/initial-write race before a new child lease is attached.
   */
  notifyFileChange(relativePath: string): void {
    if (!this.isRunning) return;
    this.handleWorkspaceFileChange(relativePath.replace(/\\/g, '/'), 'change');
  }

  stop(): void {
    if (!this.isRunning) return;
    this.stopInternal();
    debug('[ConfigWatcher] Stopped');
  }

  private stopInternal(): void {
    this.isRunning = false;
    ++this.generation;
    if (this.registryKey && this.registryRegistered) {
      const remaining = (activeWatcherCounts.get(this.registryKey) ?? 1) - 1;
      if (remaining <= 0) {
        activeWatcherCounts.delete(this.registryKey);
        activeWatchers.delete(this.registryKey);
      } else {
        activeWatcherCounts.set(this.registryKey, remaining);
      }
    }
    this.registryKey = '';
    this.registryRegistered = false;

    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    for (const lease of this.controlLeases.values()) lease.close();
    for (const lease of this.sourceLeases.values()) lease.close();
    for (const lease of this.skillLeases.values()) lease.close();
    for (const lease of this.sessionLeases.values()) lease.close();
    this.controlLeases.clear();
    this.sourceLeases.clear();
    this.skillLeases.clear();
    this.sessionLeases.clear();
    this.knownSources.clear();
    this.knownSkills.clear();
    this.knownSessions.clear();
    this.knownThemes.clear();
  }

  private ensureRequiredDirectories(): void {
    const paths = [
      this.globalConfigDir,
      this.appThemesDir,
      this.appPermissionsDir,
      this.workspaceDir,
      this.sourcesDir,
      this.skillsDir,
      this.sessionsDir,
      this.statusesDir,
      this.statusIconsDir,
      this.labelsDir,
    ];
    for (const path of paths) {
      try {
        lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(path, { recursive: true });
      }
    }
  }

  private canonicalWorkspaceKey(): string {
    try {
      return realpathSync.native(this.workspaceDir);
    } catch {
      return resolve(this.workspaceDir);
    }
  }

  private requiredWatchRequests(generation: number): DirectoryWatchRequest[] {
    return [
      this.makeRequest(this.globalConfigDir, 'global-config', 'required', generation),
      this.makeRequest(this.appThemesDir, 'app-themes', 'required', generation, undefined, {
        rejectSymlink: true,
        containWithin: this.globalConfigDir,
      }),
      this.makeRequest(this.appPermissionsDir, 'app-permissions', 'required', generation, undefined, {
        rejectSymlink: true,
        containWithin: this.globalConfigDir,
      }),
      this.makeRequest(this.workspaceDir, 'workspace-root', 'required', generation),
      this.makeRequest(this.sourcesDir, 'sources-root', 'required', generation, undefined, this.serviceOptions()),
      this.makeRequest(this.skillsDir, 'skills-root', 'required', generation, undefined, this.serviceOptions()),
      this.makeRequest(this.sessionsDir, 'sessions-root', 'required', generation, undefined, this.serviceOptions()),
      this.makeRequest(this.statusesDir, 'statuses-root', 'required', generation, undefined, this.serviceOptions()),
      this.makeRequest(this.statusIconsDir, 'status-icons', 'required', generation, undefined, this.serviceOptions()),
      this.makeRequest(this.labelsDir, 'labels-root', 'required', generation, undefined, this.serviceOptions()),
    ];
  }

  private serviceOptions() {
    return { rejectSymlink: true, containWithin: this.workspaceDir };
  }

  private makeRequest(
    path: string,
    pathClass: WatchPathClass,
    priority: WatchLeasePriority,
    generation: number,
    childId?: string,
    inspection: { rejectSymlink?: boolean; containWithin?: string } = {},
  ): DirectoryWatchRequest {
    let sawState = false;
    let wasDegraded = false;
    return {
      path,
      pathClass,
      priority,
      ...inspection,
      onEvent: (event) => {
        if (!this.isCurrent(generation)) return;
        this.handleBrokerEvent(pathClass, event, childId);
      },
      onStateChange: (state) => {
        if (!this.isCurrent(generation)) return;
        this.callbacks.onWatchStateChange?.(state);
        if (sawState && wasDegraded && state.status === 'active') {
          // Catch up changes that may have occurred while this optional or
          // quarantined path had no descriptor.
          this.handleBrokerEvent(pathClass, { eventType: 'reconcile' }, childId);
        }
        wasDegraded = state.status === 'degraded';
        sawState = true;
      },
      onDiagnostic: (diagnostic) => {
        if (!this.isCurrent(generation)) return;
        this.callbacks.onWatchDiagnostic?.(diagnostic);
      },
    };
  }

  private isCurrent(generation: number): boolean {
    return this.isRunning && this.generation === generation;
  }

  private handleBrokerEvent(pathClass: WatchPathClass, event: DirectoryWatchEvent, childId?: string): void {
    const filename = event.filename?.replace(/\\/g, '/');
    switch (pathClass) {
      case 'global-config':
        this.handleGlobalDirectoryEvent(filename);
        break;
      case 'app-themes':
        this.handleThemesDirectoryEvent(filename);
        break;
      case 'app-permissions':
        if (!filename || filename === 'default.json') {
          this.debounce('default-permissions', () => this.handleDefaultPermissionsChange());
        }
        break;
      case 'workspace-root':
        this.handleWorkspaceRootEvent(filename);
        break;
      case 'sources-root':
        this.debounce('sources-dir', () => this.handleSourcesDirChange());
        break;
      case 'source-child':
        if (childId) this.handleSourceChildEvent(childId, filename);
        break;
      case 'skills-root':
        this.debounce('skills-dir', () => this.handleSkillsDirChange());
        break;
      case 'skill-child':
        if (childId) this.handleSkillChildEvent(childId, filename);
        break;
      case 'sessions-root':
        this.debounce('sessions-dir', () => this.handleSessionsDirChange());
        break;
      case 'session-child':
        if (childId && (!filename || filename === 'session.jsonl')) {
          this.debounce(`session-meta:${childId}`, () => this.handleSessionMetadataChange(childId), SESSION_META_DEBOUNCE_MS);
        }
        break;
      case 'statuses-root':
        if (!filename || filename === 'config.json') {
          this.debounce('statuses-config', () => this.handleStatusConfigChange());
        }
        if (!filename || filename === 'icons') {
          this.controlLeases.get('status-icons')?.reconcile();
          // The replacement directory may already contain icons before the new
          // lease attaches, so always perform one bounded catch-up scan.
          this.debounce('statuses-icons-reconcile', () => this.handleAllStatusIcons());
        }
        break;
      case 'status-icons':
        if (filename) {
          this.debounce(`statuses-icon:${filename}`, () => this.handleStatusIconChange(filename));
        } else {
          this.debounce('statuses-icons-reconcile', () => this.handleAllStatusIcons());
        }
        break;
      case 'labels-root':
        if (!filename || filename === 'config.json') {
          this.debounce('labels-config', () => this.handleLabelConfigChange());
        }
        break;
      case 'session-panel-root':
      case 'session-panel-child':
        break;
    }
  }

  private handleGlobalDirectoryEvent(filename?: string): void {
    if (!filename || filename === 'config.json') {
      this.debounce('config.json', () => this.handleConfigChange());
    }
    if (!filename || filename === 'preferences.json') {
      this.debounce('preferences.json', () => this.handlePreferencesChange());
    }
    if (!filename || filename === 'theme.json') {
      this.debounce('app-theme', () => this.handleAppThemeChange());
    }
  }

  private handleThemesDirectoryEvent(filename?: string): void {
    if (!filename) {
      this.debounce('themes-reconcile', () => this.handleThemesDirChange());
      return;
    }
    if (filename.endsWith('.json')) {
      const themeId = filename.slice(0, -'.json'.length);
      this.debounce(`preset-theme:${themeId}`, () => this.handlePresetThemeChange(themeId));
    }
  }

  private handleWorkspaceRootEvent(filename?: string): void {
    if (!filename) {
      this.handleWorkspaceFileChange('permissions.json', 'rename');
      this.handleWorkspaceFileChange(AUTOMATIONS_CONFIG_FILE, 'rename');
      this.handleWorkspaceFileChange(LABEL_SKILL_BINDINGS_FILE, 'rename');
      for (const pathClass of ['sources-root', 'skills-root', 'sessions-root', 'statuses-root', 'status-icons', 'labels-root'] as const) {
        this.controlLeases.get(pathClass)?.reconcile();
      }
      this.debounce('sources-dir', () => this.handleSourcesDirChange());
      this.debounce('skills-dir', () => this.handleSkillsDirChange());
      this.debounce('sessions-dir', () => this.handleSessionsDirChange());
      this.debounce('statuses-config', () => this.handleStatusConfigChange());
      this.debounce('statuses-icons-reconcile', () => this.handleAllStatusIcons());
      this.debounce('labels-config', () => this.handleLabelConfigChange());
      return;
    }

    const directName = filename.split('/')[0]!;
    if (directName === 'sources') {
      this.controlLeases.get('sources-root')?.reconcile();
      this.debounce('sources-dir', () => this.handleSourcesDirChange());
    } else if (directName === 'skills') {
      this.controlLeases.get('skills-root')?.reconcile();
      this.debounce('skills-dir', () => this.handleSkillsDirChange());
    } else if (directName === 'sessions') {
      this.controlLeases.get('sessions-root')?.reconcile();
      this.debounce('sessions-dir', () => this.handleSessionsDirChange());
    } else if (directName === 'statuses') {
      this.controlLeases.get('statuses-root')?.reconcile();
      this.controlLeases.get('status-icons')?.reconcile();
    } else if (directName === 'labels') {
      this.controlLeases.get('labels-root')?.reconcile();
    } else {
      this.handleWorkspaceFileChange(filename, 'rename');
    }
  }

  private handleSourceChildEvent(slug: string, filename?: string): void {
    if (!filename || filename === 'config.json') {
      this.debounce(`source-config:${slug}`, () => this.handleSourceConfigChange(slug));
    }
    if (!filename || filename === 'guide.md') {
      this.debounce(`source-guide:${slug}`, () => this.handleSourceGuideChange(slug));
    }
    if (!filename || filename === 'permissions.json') {
      this.debounce(`source-permissions:${slug}`, () => this.handleSourcePermissionsChange(slug));
    }
  }

  private handleSkillChildEvent(slug: string, filename?: string): void {
    if (!filename || filename === 'SKILL.md' || /^icon\.(svg|png|jpg|jpeg)$/i.test(filename)) {
      this.debounce(`skill:${slug}`, () => this.handleSkillChange(slug));
    }
  }

  /** Handle authoritative/manual workspace-relative changes. */
  private handleWorkspaceFileChange(relativePath: string, _eventType: string): void {
    const parts = relativePath.split('/').filter(Boolean);
    if (relativePath === 'permissions.json') {
      this.debounce('workspace-permissions', () => this.handleWorkspacePermissionsChange());
      return;
    }
    if (relativePath === AUTOMATIONS_CONFIG_FILE) {
      this.debounce('automations-config', () => this.handleAutomationsConfigChange());
      return;
    }
    if (relativePath === LABEL_SKILL_BINDINGS_FILE) {
      this.debounce('label-skill-bindings-config', () => this.handleLabelSkillBindingsConfigChange());
      return;
    }

    if (parts[0] === 'sources' && parts[1]) {
      if (parts.length === 2) this.debounce('sources-dir', () => this.handleSourcesDirChange());
      else this.handleSourceChildEvent(parts[1], parts[2]);
      return;
    }
    if (parts[0] === 'skills' && parts[1]) {
      if (parts.length === 2) this.debounce('skills-dir', () => this.handleSkillsDirChange());
      else this.handleSkillChildEvent(parts[1], parts[2]);
      return;
    }
    if (parts[0] === 'sessions' && parts[1]) {
      if (parts.length === 2) this.debounce('sessions-dir', () => this.handleSessionsDirChange());
      else if (parts[2] === 'session.jsonl') {
        this.debounce(`session-meta:${parts[1]}`, () => this.handleSessionMetadataChange(parts[1]!), SESSION_META_DEBOUNCE_MS);
      }
      return;
    }
    if (parts[0] === 'statuses' && parts[1] === 'config.json') {
      this.debounce('statuses-config', () => this.handleStatusConfigChange());
      return;
    }
    if (parts[0] === 'statuses' && parts[1] === 'icons' && parts[2]) {
      this.debounce(`statuses-icon:${parts[2]}`, () => this.handleStatusIconChange(parts[2]!));
      return;
    }
    if (parts[0] === 'labels' && parts[1] === 'config.json') {
      this.debounce('labels-config', () => this.handleLabelConfigChange());
    }
  }

  /**
   * Debounce a handler by key
   */
  private debounce(key: string, handler: () => void, delayMs: number = DEBOUNCE_MS): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const generation = this.generation;

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      if (!this.isCurrent(generation)) return;
      handler();
    }, delayMs);

    this.debounceTimers.set(key, timer);
  }

  private listSafeDirectChildren(
    parentDir: string,
    pathClass: 'source-child' | 'skill-child' | 'session-child',
    priority: 'source' | 'skill' | 'session',
  ): string[] {
    if (!existsSync(parentDir)) return [];
    const names: string[] = [];
    let parentPhysical: string;
    try {
      parentPhysical = realpathSync.native(parentDir);
    } catch {
      return [];
    }

    const directory = opendirSync(parentDir);
    let inspected = 0;
    try {
      while (true) {
        const entry = directory.readSync();
        if (!entry) return names.sort();
        if (inspected >= MAX_DIRECT_CHILDREN_PER_SERVICE) {
          this.emitWatchDegraded(pathClass, priority, 'capacity');
          return names.sort();
        }
        inspected += 1;
        const entryPath = join(parentDir, entry.name);
        try {
          const stats = lstatSync(entryPath);
          if (stats.isSymbolicLink()) {
            this.emitWatchDegraded(pathClass, priority, 'unsafe-symlink');
            continue;
          }
          if (!stats.isDirectory()) continue;
          const physical = realpathSync.native(entryPath);
          const rel = relative(parentPhysical, physical);
          if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
            this.emitWatchDegraded(pathClass, priority, 'outside-root');
            continue;
          }
          names.push(entry.name);
        } catch {
          this.emitWatchDegraded(pathClass, priority, 'invalid-directory');
        }
      }
    } finally {
      directory.closeSync();
    }
  }

  private listBoundedDirectFiles(
    parentDir: string,
    pathClass: WatchPathClass,
    priority: WatchLeasePriority,
    include: (filename: string) => boolean,
  ): string[] {
    if (!existsSync(parentDir)) return [];
    const files: string[] = [];
    const directory = opendirSync(parentDir);
    let inspected = 0;
    try {
      while (true) {
        const entry = directory.readSync();
        if (!entry) return files;
        if (inspected >= MAX_DIRECT_CHILDREN_PER_SERVICE) {
          this.emitWatchDegraded(pathClass, priority, 'capacity');
          return files;
        }
        inspected += 1;
        if (entry.isFile() && include(entry.name)) files.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
  }

  private emitWatchDegraded(
    pathClass: WatchPathClass,
    priority: WatchLeasePriority,
    reason: WatchLeaseState['reason'],
  ): void {
    if (!reason) return;
    const snapshot = this.broker.getSnapshot();
    this.callbacks.onWatchStateChange?.({ status: 'degraded', pathClass, priority, reason });
    this.callbacks.onWatchDiagnostic?.({
      type: 'degraded',
      pathClass,
      priority,
      activeDirectoryCount: snapshot.activeDirectoryCount,
      leaseCount: snapshot.leaseCount,
      capacity: snapshot.capacity,
      reason,
    });
  }

  private syncOptionalLeases(
    names: Set<string>,
    leases: Map<string, DirectoryWatchLease>,
    parentDir: string,
    pathClass: 'source-child' | 'skill-child' | 'session-child',
    priority: 'source' | 'skill' | 'session',
  ): Set<string> {
    const added = new Set<string>();
    for (const [name, lease] of leases) {
      if (!names.has(name)) {
        lease.close();
        leases.delete(name);
      }
    }
    for (const name of names) {
      if (leases.has(name)) continue;
      const generation = this.generation;
      const lease = this.broker.acquireOptional(this.makeRequest(
        join(parentDir, name),
        pathClass,
        priority,
        generation,
        name,
        { rejectSymlink: true, containWithin: parentDir },
      ));
      leases.set(name, lease);
      added.add(name);
    }
    return added;
  }

  // ============================================================
  // Sources Handlers
  // ============================================================

  private scanSources(emitChanges: boolean): void {
    try {
      const currentFolders = new Set(this.listSafeDirectChildren(this.sourcesDir, 'source-child', 'source'));
      const added = this.syncOptionalLeases(currentFolders, this.sourceLeases, this.sourcesDir, 'source-child', 'source');
      if (emitChanges) {
        for (const folder of added) {
          const source = loadSource(this.workspaceDir, folder);
          if (source) this.callbacks.onSourceChange?.(folder, source);
        }
        for (const folder of this.knownSources) {
          if (!currentFolders.has(folder)) this.callbacks.onSourceChange?.(folder, null);
        }
      }
      this.knownSources.clear();
      for (const folder of currentFolders) this.knownSources.add(folder);
      debug('[ConfigWatcher] Known sources:', Array.from(this.knownSources));
    } catch (error) {
      debug('[ConfigWatcher] Error scanning sources:', error);
      this.callbacks.onError?.('sources/', error as Error);
    }
  }

  private handleSourcesDirChange(): void {
    debug('[ConfigWatcher] Sources directory changed');
    this.scanSources(true);
    this.callbacks.onSourcesListChange?.(existsSync(this.sourcesDir) ? loadWorkspaceSources(this.workspaceDir) : []);
  }

  /**
   * Handle source config.json change
   * Downloads icon if URL specified and no local icon exists
   */
  private handleSourceConfigChange(slug: string): void {
    debug('[ConfigWatcher] Source config changed:', slug);

    const validation = validateSource(this.workspaceDir, slug);
    if (!validation.valid) {
      debug('[ConfigWatcher] Source validation failed:', slug, validation.errors);
      this.callbacks.onValidationError?.(`sources/${slug}/config.json`, validation);
      return;
    }

    const source = loadSource(this.workspaceDir, slug);

    // Check if icon needs to be downloaded (URL in config, no local file)
    if (source && sourceNeedsIconDownload(this.workspaceDir, slug, source.config)) {
      debug('[ConfigWatcher] Downloading source icon:', slug);
      const generation = this.generation;
      downloadSourceIcon(this.workspaceDir, slug, source.config.icon!)
        .then((iconPath) => {
          if (iconPath && this.isCurrent(generation)) {
            debug('[ConfigWatcher] Source icon downloaded:', slug, iconPath);
            // Re-emit source change with updated icon path
            const updatedSource = loadSource(this.workspaceDir, slug);
            this.callbacks.onSourceChange?.(slug, updatedSource);
          }
        })
        .catch((err) => {
          debug('[ConfigWatcher] Source icon download failed:', slug, err);
        });
    }

    this.callbacks.onSourceChange?.(slug, source);
  }

  /**
   * Handle source guide.md change
   */
  private handleSourceGuideChange(slug: string): void {
    debug('[ConfigWatcher] Source guide changed:', slug);

    const guide = loadSourceGuide(this.workspaceDir, slug);
    if (guide) {
      this.callbacks.onSourceGuideChange?.(slug, guide);
    }

    // Also emit full source change
    const source = loadSource(this.workspaceDir, slug);
    if (source) {
      this.callbacks.onSourceChange?.(slug, source);
    }
  }

  /**
   * Handle source permissions.json change
   */
  private handleSourcePermissionsChange(slug: string): void {
    debug('[ConfigWatcher] Source permissions.json changed:', slug);

    // Invalidate cache
    permissionsConfigCache.invalidateSource(this.workspaceDir, slug);

    // Notify callback
    this.callbacks.onSourcePermissionsChange?.(slug);
  }

  // ============================================================
  // Skills Handlers
  // ============================================================

  private scanSkills(emitChanges: boolean): void {
    try {
      const currentFolders = new Set(this.listSafeDirectChildren(this.skillsDir, 'skill-child', 'skill'));
      const added = this.syncOptionalLeases(currentFolders, this.skillLeases, this.skillsDir, 'skill-child', 'skill');
      if (emitChanges) {
        invalidateSkillsCache();
        for (const folder of added) {
          const skill = loadSkill(this.workspaceDir, folder);
          if (skill) this.callbacks.onSkillChange?.(folder, skill);
        }
        for (const folder of this.knownSkills) {
          if (!currentFolders.has(folder)) this.callbacks.onSkillChange?.(folder, null);
        }
      }
      this.knownSkills.clear();
      for (const folder of currentFolders) this.knownSkills.add(folder);
      debug('[ConfigWatcher] Known skills:', Array.from(this.knownSkills));
    } catch (error) {
      debug('[ConfigWatcher] Error scanning skills:', error);
      this.callbacks.onError?.('skills/', error as Error);
    }
  }

  private handleSkillsDirChange(): void {
    debug('[ConfigWatcher] Skills directory changed');
    invalidateSkillsCache();
    this.scanSkills(true);
    this.callbacks.onSkillsListChange?.(existsSync(this.skillsDir) ? loadAllSkills(this.workspaceDir) : []);
  }

  /**
   * Handle skill SKILL.md or icon change.
   * If the skill has an icon URL in metadata but no local icon file,
   * downloads the icon and emits another change event after completion.
   */
  private handleSkillChange(slug: string): void {
    debug('[ConfigWatcher] Skill changed:', slug);

    // SKILL.md/frontmatter and icon changes affect both full-skill and summary
    // caches. Invalidate before loading/broadcasting so downstream callbacks that
    // call loadAllSkills/listSkillSummaries see the changed metadata immediately.
    invalidateSkillsCache();

    const skill = loadSkill(this.workspaceDir, slug);
    this.callbacks.onSkillChange?.(slug, skill);

    // Check if we need to download an icon from URL
    // This happens when SKILL.md has icon: "https://..." but no local icon.* file exists
    if (skill && skillNeedsIconDownload(skill)) {
      debug('[ConfigWatcher] Skill needs icon download:', slug, skill.metadata.icon);
      const generation = this.generation;

      // Download asynchronously - don't block the watcher
      downloadSkillIcon(skill.path, skill.metadata.icon!)
        .then((iconPath) => {
          if (iconPath && this.isCurrent(generation)) {
            // Reload the skill with the new icon and emit another change
            invalidateSkillsCache();
            const updatedSkill = loadSkill(this.workspaceDir, slug);
            debug('[ConfigWatcher] Icon downloaded, emitting updated skill:', slug);
            this.callbacks.onSkillChange?.(slug, updatedSkill);
          }
        })
        .catch((error) => {
          debug('[ConfigWatcher] Icon download failed for skill:', slug, error);
        });
    }
  }

  // ============================================================
  // Safe Mode & Config Handlers
  // ============================================================

  /**
   * Handle workspace permissions.json change
   */
  private handleWorkspacePermissionsChange(): void {
    debug('[ConfigWatcher] Workspace permissions.json changed:', this.workspaceId);

    // Invalidate cache
    permissionsConfigCache.invalidateWorkspace(this.workspaceDir);

    // Notify callback
    this.callbacks.onWorkspacePermissionsChange?.(this.workspaceId);
  }

  /**
   * Handle config.json change
   */
  private handleConfigChange(): void {
    debug('[ConfigWatcher] config.json changed');

    const validation = validateConfig();
    if (!validation.valid) {
      debug('[ConfigWatcher] Config validation failed:', validation.errors);
      this.callbacks.onValidationError?.('config.json', validation);
      return;
    }

    const config = loadStoredConfig();
    if (config) {
      this.callbacks.onConfigChange?.(config);

      // Check for LLM connections changes
      // Use JSON hash comparison for deep equality check
      const connections = config.llmConnections || [];
      const currentHash = JSON.stringify(connections);
      if (currentHash !== this.lastLlmConnectionsHash) {
        debug('[ConfigWatcher] LLM connections changed');
        this.lastLlmConnectionsHash = currentHash;
        this.callbacks.onLlmConnectionsChange?.(connections);
      }
    } else {
      this.callbacks.onError?.('config.json', new Error('Failed to load config'));
    }
  }

  /**
   * Handle preferences.json change
   */
  private handlePreferencesChange(): void {
    debug('[ConfigWatcher] preferences.json changed');

    const validation = validatePreferences();
    if (!validation.valid) {
      debug('[ConfigWatcher] Preferences validation failed:', validation.errors);
      this.callbacks.onValidationError?.('preferences.json', validation);
      return;
    }

    const prefs = loadPreferences();
    if (prefs) {
      this.callbacks.onPreferencesChange?.(prefs);
    }
  }

  // ============================================================
  // Statuses Handlers
  // ============================================================

  /**
   * Handle statuses config.json change
   * Downloads icons for any status with URL icon and no local file
   */
  private handleStatusConfigChange(): void {
    debug('[ConfigWatcher] Statuses config.json changed:', this.workspaceId);

    // Load config and check for icons that need downloading
    const config = loadStatusConfig(this.workspaceDir);
    for (const status of config.statuses) {
      if (statusNeedsIconDownload(this.workspaceDir, status)) {
        debug('[ConfigWatcher] Downloading status icon:', status.id);
        const generation = this.generation;
        downloadStatusIcon(this.workspaceDir, status.id, status.icon!)
          .then((iconPath) => {
            if (iconPath && this.isCurrent(generation)) {
              debug('[ConfigWatcher] Status icon downloaded:', status.id, iconPath);
              // Re-emit config change to update UI with new icon
              this.callbacks.onStatusConfigChange?.(this.workspaceId);
            }
          })
          .catch((err) => {
            debug('[ConfigWatcher] Status icon download failed:', status.id, err);
          });
      }
    }

    this.callbacks.onStatusConfigChange?.(this.workspaceId);
  }

  /**
   * Handle status icon file change
   */
  private handleStatusIconChange(iconFilename: string): void {
    debug('[ConfigWatcher] Status icon changed:', this.workspaceId, iconFilename);
    this.callbacks.onStatusIconChange?.(this.workspaceId, iconFilename);
  }

  private handleAllStatusIcons(): void {
    if (!existsSync(this.statusIconsDir)) return;
    try {
      const files = this.listBoundedDirectFiles(
        this.statusIconsDir,
        'status-icons',
        'required',
        () => true,
      );
      for (const file of files) this.handleStatusIconChange(file);
    } catch (error) {
      this.callbacks.onError?.('statuses/icons/', error as Error);
    }
  }

  // ============================================================
  // Labels Handlers
  // ============================================================

  /**
   * Handle labels config.json change.
   */
  private handleLabelConfigChange(): void {
    debug('[ConfigWatcher] Labels config.json changed:', this.workspaceId);
    this.callbacks.onLabelConfigChange?.(this.workspaceId);
  }

  /**
   * Handle label-skill-bindings.json change.
   */
  private handleLabelSkillBindingsConfigChange(): void {
    debug('[ConfigWatcher] Label-skill bindings config changed:', this.workspaceId);
    this.callbacks.onLabelSkillBindingsConfigChange?.(this.workspaceId);
  }

  /**
   * Handle automations config change.
   */
  private handleAutomationsConfigChange(): void {
    debug('[ConfigWatcher] automations config changed:', this.workspaceId);
    this.callbacks.onAutomationsConfigChange?.(this.workspaceId);
  }

  // ============================================================
  // Session Metadata Handlers
  // ============================================================

  private scanSessions(emitInitialForAdded: boolean): void {
    try {
      const currentFolders = new Set(this.listSafeDirectChildren(this.sessionsDir, 'session-child', 'session'));
      const newlyObserved = this.syncOptionalLeases(
        currentFolders,
        this.sessionLeases,
        this.sessionsDir,
        'session-child',
        'session',
      );
      if (emitInitialForAdded) {
        // Read immediately after acquisition. The initial session.jsonl write may
        // have completed before the new child watcher could be attached.
        for (const sessionId of newlyObserved) this.handleSessionMetadataChange(sessionId);
      }
      this.knownSessions.clear();
      for (const sessionId of currentFolders) this.knownSessions.add(sessionId);
    } catch (error) {
      debug('[ConfigWatcher] Error scanning sessions:', error);
      this.callbacks.onError?.('sessions/', error as Error);
    }
  }

  private handleSessionsDirChange(): void {
    this.scanSessions(true);
  }

  /**
   * Handle session.jsonl change — reads only line 1 (header) and emits if valid.
   * This enables detection of external metadata changes (labels, name, flags)
   * made by other instances, scripts, or manual edits.
   */
  private handleSessionMetadataChange(sessionId: string): void {
    const sessionFile = join(this.workspaceDir, 'sessions', sessionId, 'session.jsonl');

    if (!existsSync(sessionFile)) {
      return;
    }

    const header = readSessionHeader(sessionFile);
    if (header) {
      this.callbacks.onSessionMetadataChange?.(sessionId, header);
    }
  }

  // ============================================================
  // Theme Handlers (App-Level)
  // ============================================================

  /**
   * Handle app-level theme.json change
   */
  private handleAppThemeChange(): void {
    debug('[ConfigWatcher] App theme.json changed');
    const theme = loadAppTheme();
    this.callbacks.onAppThemeChange?.(theme);
  }

  /**
   * Handle default.json permissions change (app-level)
   */
  private handleDefaultPermissionsChange(): void {
    debug('[ConfigWatcher] Default permissions changed');

    // Invalidate the cache so next getMergedConfig() reloads from file
    permissionsConfigCache.invalidateDefaults();

    // Notify callback
    this.callbacks.onDefaultPermissionsChange?.();
  }

  /**
   * Scan app-level themes directory to populate known themes
   */
  private scanAppThemes(): void {
    if (!existsSync(this.appThemesDir)) return;
    try {
      const files = this.listBoundedDirectFiles(
        this.appThemesDir,
        'app-themes',
        'required',
        filename => filename.endsWith('.json'),
      );
      this.knownThemes.clear();
      for (const file of files) this.knownThemes.add(file.slice(0, -'.json'.length));
      debug('[ConfigWatcher] Known themes:', Array.from(this.knownThemes));
    } catch (error) {
      debug('[ConfigWatcher] Error scanning themes:', error);
    }
  }

  private handleThemesDirChange(): void {
    const previous = new Set(this.knownThemes);
    this.scanAppThemes();
    for (const themeId of previous) {
      if (!this.knownThemes.has(themeId)) this.callbacks.onPresetThemeChange?.(themeId, null);
    }
    for (const themeId of this.knownThemes) this.handlePresetThemeChange(themeId);
    this.callbacks.onPresetThemesListChange?.(loadPresetThemes());
  }

  /**
   * Handle preset theme file change (app-level)
   */
  private handlePresetThemeChange(themeId: string): void {
    debug('[ConfigWatcher] Preset theme changed:', themeId);

    const themePath = join(this.appThemesDir, `${themeId}.json`);

    if (!existsSync(themePath)) {
      // Theme was deleted
      if (this.knownThemes.has(themeId)) {
        this.knownThemes.delete(themeId);
        this.callbacks.onPresetThemeChange?.(themeId, null);

        // Also notify list change
        const allThemes = loadPresetThemes();
        this.callbacks.onPresetThemesListChange?.(allThemes);
      }
      return;
    }

    // Theme was added or modified
    if (!this.knownThemes.has(themeId)) {
      this.knownThemes.add(themeId);
    }

    const theme = loadPresetTheme(themeId);
    this.callbacks.onPresetThemeChange?.(themeId, theme);

    // Also notify list change in case name changed (affects sorting)
    const allThemes = loadPresetThemes();
    this.callbacks.onPresetThemesListChange?.(allThemes);
  }
}

// ============================================================
// Factory Function
// ============================================================

/**
 * Create and start a config watcher for a specific workspace.
 * Returns the watcher instance for later cleanup.
 */
export function createConfigWatcher(
  workspaceId: string,
  callbacks: ConfigWatcherCallbacks,
  options: ConfigWatcherOptions = {},
): ConfigWatcher {
  const watcher = new ConfigWatcher(workspaceId, callbacks, options);
  watcher.start();
  return watcher;
}
