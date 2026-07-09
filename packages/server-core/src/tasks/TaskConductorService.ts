import type { Workspace } from '@craft-agent/core/types';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { TaskRunner, type ConductorSessionHost, type RunOptions, type RunSnapshot, type TaskRunnerDeps } from './TaskRunner';

export interface TaskConductorServiceDeps {
  /** SessionManager-like host used by every in-memory TaskRunner. */
  host: ConductorSessionHost;
  /** Injectable workspace resolver for tests/headless runtimes. Defaults to the shared config store. */
  workspaceResolver?: (workspaceId: string) => Workspace | null | undefined;
  summarize?: TaskRunnerDeps['summarize'];
  defaultMaxParallel?: TaskRunnerDeps['defaultMaxParallel'];
  now?: TaskRunnerDeps['now'];
  genRunId?: TaskRunnerDeps['genRunId'];
}

/**
 * Singleton-capable task conductor facade.
 *
 * The active run map lives inside one TaskRunner per workspace. RPC handlers and
 * future agent/session-tool callbacks must share the same service instance for a
 * given SessionManager host; otherwise pause/resume/stop callbacks would look at
 * a different in-memory runner map than tasks:run.
 */
export class TaskConductorService {
  private readonly runners = new Map<string, TaskRunner>();
  private readonly workspaceResolver: (workspaceId: string) => Workspace | null | undefined;

  constructor(private readonly deps: TaskConductorServiceDeps) {
    this.workspaceResolver = deps.workspaceResolver ?? getWorkspaceByNameOrId;
  }

  workspaceOrThrow(workspaceId: string): Workspace {
    const ws = this.workspaceResolver(workspaceId);
    if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
    return ws;
  }

  /** Return the shared runner for a workspace, creating it on first use. */
  runnerFor(workspaceId: string): TaskRunner {
    let runner = this.runners.get(workspaceId);
    if (!runner) {
      const ws = this.workspaceOrThrow(workspaceId);
      const runnerDeps: TaskRunnerDeps = {
        host: this.deps.host,
        workspaceId: ws.id,
        workspaceRoot: ws.rootPath,
      };
      if (this.deps.summarize) runnerDeps.summarize = this.deps.summarize;
      if (this.deps.defaultMaxParallel !== undefined) runnerDeps.defaultMaxParallel = this.deps.defaultMaxParallel;
      if (this.deps.now) runnerDeps.now = this.deps.now;
      if (this.deps.genRunId) runnerDeps.genRunId = this.deps.genRunId;
      runner = new TaskRunner(runnerDeps);
      this.runners.set(workspaceId, runner);
    }
    return runner;
  }

  run(workspaceId: string, slug: string, opts: RunOptions = {}): RunSnapshot {
    return this.runnerFor(workspaceId).run(slug, opts);
  }

  pause(workspaceId: string, slug: string, runId: string): void {
    this.runnerFor(workspaceId).pause(slug, runId);
  }

  resume(workspaceId: string, slug: string, runId: string): void {
    this.runnerFor(workspaceId).resume(slug, runId);
  }

  stop(workspaceId: string, slug: string, runId: string): Promise<void> {
    return this.runnerFor(workspaceId).stop(slug, runId);
  }

  getRunState(workspaceId: string, slug: string, runId: string): RunSnapshot | null {
    return this.runnerFor(workspaceId).getRunState(slug, runId);
  }

  waitUntilSettled(workspaceId: string, slug: string, runId: string): Promise<RunSnapshot> {
    return this.runnerFor(workspaceId).waitUntilSettled(slug, runId);
  }
}

const defaultServices = new WeakMap<ConductorSessionHost, TaskConductorService>();

/**
 * Fallback singleton path for composition roots that do not yet inject an
 * explicit TaskConductorService. Keying by the SessionManager-like host keeps
 * all task entry points in one process on the same active-run map.
 */
export function getOrCreateTaskConductorService(deps: TaskConductorServiceDeps): TaskConductorService {
  const existing = defaultServices.get(deps.host);
  if (existing) return existing;
  const service = new TaskConductorService(deps);
  defaultServices.set(deps.host, service);
  return service;
}
