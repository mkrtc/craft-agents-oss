import {
  lstatSync,
  realpathSync,
  statSync,
  watch,
  type FSWatcher,
  type Stats,
} from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';
import type { WatchDegradedReason } from './watch-diagnostics.ts';

export interface DirectoryWatchEvent {
  eventType: string;
  filename?: string;
}

export interface DirectoryIdentity {
  key: string;
  requestedPath: string;
  watchPath: string;
  present: boolean;
  fingerprint: string;
}

export interface DirectoryInspectionOptions {
  rejectSymlink?: boolean;
  containWithin?: string;
  allowMissing?: boolean;
}

export interface DirectoryWatchHandle {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
}

export interface DirectoryWatchAdapter {
  inspect(path: string, options?: DirectoryInspectionOptions): DirectoryIdentity;
  watch(path: string, listener: (event: DirectoryWatchEvent) => void): DirectoryWatchHandle;
}

export class WatchPathError extends Error {
  readonly reason: WatchDegradedReason;
  readonly code?: string;

  constructor(message: string, reason: WatchDegradedReason, code?: string) {
    super(message);
    this.name = 'WatchPathError';
    this.reason = reason;
    this.code = code;
  }
}

function normalizeKeyPath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function isMissingError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function resolveContainmentRoot(rootPath: string): string {
  const absolute = resolve(rootPath);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if (isMissingError(error)) return absolute;
    throw error;
  }
}

function assertContained(
  candidate: string,
  containmentRoot: string | undefined,
  candidatePresent: boolean,
): void {
  if (!containmentRoot) return;

  const requestedRoot = resolve(containmentRoot);
  const root = resolveContainmentRoot(containmentRoot);
  const comparableCandidate = candidatePresent ? candidate : resolve(candidate);
  const contained = candidatePresent
    ? isContained(root, comparableCandidate)
    : isContained(requestedRoot, comparableCandidate) || isContained(root, comparableCandidate);
  if (!contained) {
    throw new WatchPathError(
      'Watch directory resolves outside its allowed root',
      'outside-root',
    );
  }
}

function fingerprint(stats: Stats): string {
  return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.mode)}`;
}

export class NodeDirectoryWatchAdapter implements DirectoryWatchAdapter {
  inspect(path: string, options: DirectoryInspectionOptions = {}): DirectoryIdentity {
    const requestedPath = resolve(path);
    let requestedStats: Stats;

    try {
      requestedStats = lstatSync(requestedPath);
    } catch (error) {
      if (isMissingError(error) && options.allowMissing !== false) {
        assertContained(requestedPath, options.containWithin, false);
        return {
          key: `missing:${normalizeKeyPath(requestedPath)}`,
          requestedPath,
          watchPath: requestedPath,
          present: false,
          fingerprint: 'missing',
        };
      }

      throw new WatchPathError(
        'Unable to inspect watch directory',
        'invalid-directory',
        errorCode(error),
      );
    }

    if (requestedStats.isSymbolicLink() && options.rejectSymlink) {
      throw new WatchPathError(
        'Symbolic-link watch directories are not allowed for this path class',
        'unsafe-symlink',
      );
    }

    let physicalPath: string;
    try {
      physicalPath = realpathSync.native(requestedPath);
      if (!statSync(physicalPath).isDirectory()) {
        throw new WatchPathError('Watch target is not a directory', 'invalid-directory');
      }
    } catch (error) {
      if (error instanceof WatchPathError) throw error;
      throw new WatchPathError(
        'Unable to resolve watch directory',
        'invalid-directory',
        errorCode(error),
      );
    }

    assertContained(physicalPath, options.containWithin, true);

    const physicalStats = lstatSync(physicalPath);
    return {
      key: `directory:${normalizeKeyPath(physicalPath)}`,
      requestedPath,
      watchPath: physicalPath,
      present: true,
      fingerprint: fingerprint(physicalStats),
    };
  }

  watch(path: string, listener: (event: DirectoryWatchEvent) => void): FSWatcher {
    // Intentionally non-recursive. Recursive production watchers are prohibited.
    return watch(path, (eventType, filename) => {
      listener({
        eventType,
        filename: filename == null ? undefined : String(filename),
      });
    });
  }
}

export function getWatchErrorCode(error: unknown): string | undefined {
  return errorCode(error);
}
