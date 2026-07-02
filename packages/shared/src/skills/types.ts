/**
 * Skills Types
 *
 * Type definitions for workspace skills.
 * Skills are specialized instructions that extend Claude's capabilities.
 */

/**
 * Skill metadata from SKILL.md YAML frontmatter
 */
export interface SkillMetadata {
  /** Display name for the skill */
  name: string;
  /** Brief description shown in skill list */
  description: string;
  /** Optional file patterns that trigger this skill */
  globs?: string[];
  /** Optional tools to always allow when skill is active */
  alwaysAllow?: string[];
  /**
   * Optional icon - emoji or URL only.
   * - Emoji: rendered directly in UI (e.g., "🔧")
   * - URL: auto-downloaded to icon.{ext} file
   * Note: Relative paths and inline SVG are NOT supported.
   */
  icon?: string;
  /** Optional source slugs to auto-enable when this skill is invoked */
  requiredSources?: string[];
}

/** Source of a loaded skill */
export type SkillSource = 'global' | 'workspace' | 'project';

/**
 * Plugin name for project-level and global skills.
 *
 * The SDK derives plugin names from `path.basename()` of the registered plugin
 * directory. Both `{project}/.agents/` and `~/.agents/` share the basename
 * `.agents`, so skills from either tier resolve to `.agents:skillSlug`.
 */
export const AGENTS_PLUGIN_NAME = '.agents';

/**
 * A loaded skill with parsed content
 */
export interface LoadedSkill {
  /** Directory name (slug) */
  slug: string;
  /** Parsed metadata from YAML frontmatter */
  metadata: SkillMetadata;
  /** Full SKILL.md content (without frontmatter) */
  content: string;
  /** Absolute path to icon file if exists */
  iconPath?: string;
  /** Absolute path to skill directory */
  path: string;
  /** Where this skill was loaded from */
  source: SkillSource;
}

/**
 * Display-safe, metadata-only skill summary.
 *
 * This intentionally excludes full SKILL.md content and absolute local paths so
 * renderer/RPC callers can list bindable skills without exposing private file
 * system details or triggering full skill-body reads.
 */
export interface SkillSummary {
  /** Directory name (slug) */
  slug: string;
  /** Parsed metadata from YAML frontmatter */
  metadata: SkillMetadata;
  /** Where this skill was resolved from after priority overlay */
  source: SkillSource;
  /** Stable hash of the parsed frontmatter metadata */
  metadataHash: string;
  /** Optional full-content hash; only populated for explicit callers that opt in */
  contentHash?: string;
  /** Display-only scope hint such as "Global", "Workspace", or a project folder name */
  scopeLabel: string;
  /** Fingerprint for source/scope matching; not a local path */
  scopeFingerprint: string;
  /** Required source slugs copied from frontmatter for pre-enable flows */
  requiredSources?: string[];
}

/** Internal metadata summary that can include local paths. Do not send over RPC. */
export interface SkillPathSummary extends SkillSummary {
  /** Absolute path to the skill directory */
  path: string;
  /** Absolute path to SKILL.md */
  skillFilePath: string;
}
