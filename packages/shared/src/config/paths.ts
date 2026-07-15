/**
 * Centralized path configuration for Craft Agent.
 *
 * Supports multi-instance development via CRAFT_CONFIG_DIR environment variable.
 * When running from a numbered folder (e.g., craft-tui-agent-1), the detect-instance.sh
 * script sets CRAFT_CONFIG_DIR to ~/.craft-agent-1, allowing multiple instances to run
 * simultaneously with separate configurations.
 *
 * Default (non-numbered folders): ~/.craft-agent/
 * Instance 1 (-1 suffix): ~/.craft-agent-1/
 * Instance 2 (-2 suffix): ~/.craft-agent-2/
 */

import { homedir } from 'os';
import { join } from 'path';

// Allow override via environment variable for multi-instance dev
// Falls back to default ~/.craft-agent/ for production and non-numbered dev folders
export const CONFIG_DIR = process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent');

let configDirOverrideForTests: string | null = null;

/** Return the active config directory. Production callers get CONFIG_DIR; tests may override it without reloading modules. */
export function getConfigDir(): string {
  return configDirOverrideForTests ?? CONFIG_DIR;
}

/** Test-only hook for suites that need multiple isolated config roots in one Bun process. */
export function __setConfigDirForTests(dir: string | null): void {
  configDirOverrideForTests = dir;
}
