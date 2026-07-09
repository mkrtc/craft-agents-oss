import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { loadTaskSpec } from '@craft-agent/shared/tasks'
import { getOrCreateTaskConductorService } from '../tasks'
import { registerTasksHandlers } from '../handlers/rpc/tasks.ts'
import { SessionManager } from './SessionManager.ts'

const VALID_TASK_YAML = `id: demo-task
title: Demo Task
goal: Demo goal
sources:
  - linear
nodes:
  - id: inspect
    prompt: Inspect the code.
`

function makeManaged(rootPath: string) {
  return {
    id: 'caller-session',
    workspace: { id: 'workspace-1', rootPath },
    messages: [],
    agent: null,
    isProcessing: false,
    lastMessageAt: 0,
    streamingText: '',
    processingGeneration: 0,
    isFlagged: false,
  }
}

describe('SessionManager task tool callbacks', () => {
  it('task_create saves the spec and binds/adopts only the current caller session', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'craft-task-callbacks-'))
    const sm = new SessionManager()
    const managed = makeManaged(rootPath)
    const calls: Array<{ name: string; args: unknown[] }> = []

    // Isolate the callback contract from the already-tested bind/adopt persistence details.
    const anySm = sm as any
    anySm.adoptGeneratedTaskOrchestrator = async (...args: unknown[]) => {
      calls.push({ name: 'adopt', args })
      return false
    }
    anySm.bindExistingSessionToTask = async (...args: unknown[]) => {
      calls.push({ name: 'bind', args })
      return true
    }
    anySm.applyTaskLabel = async (...args: unknown[]) => {
      calls.push({ name: 'label', args })
      return { labelId: 'task-label-id' }
    }
    anySm.setSessionSources = async (...args: unknown[]) => {
      calls.push({ name: 'sources', args })
    }

    const taskTools = anySm.createSessionTaskToolCallbacks(managed)
    const result = await taskTools.create({ yaml: VALID_TASK_YAML }, {
      callerSessionId: managed.id,
      workspacePath: rootPath,
      workingDirectory: rootPath,
    })

    expect(result).toMatchObject({
      slug: 'demo-task',
      orchestratorSessionId: managed.id,
      taskLabelId: 'task-label-id',
      validation: { valid: true },
    })
    expect(calls.find((c) => c.name === 'adopt')?.args.slice(0, 2)).toEqual([managed.id, 'demo-task'])
    expect(calls.find((c) => c.name === 'bind')?.args.slice(0, 2)).toEqual([managed.id, 'demo-task'])
    expect(calls.find((c) => c.name === 'sources')?.args).toEqual([managed.id, ['linear']])
  })

  it('task_create does not persist task.yaml when current-session binding fails', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'craft-task-callback-bind-fail-'))
    const sm = new SessionManager()
    const managed = makeManaged(rootPath)
    const anySm = sm as any

    anySm.adoptGeneratedTaskOrchestrator = async () => false
    anySm.bindExistingSessionToTask = async () => false

    const taskTools = anySm.createSessionTaskToolCallbacks(managed)
    await expect(taskTools.create({ yaml: VALID_TASK_YAML }, {
      callerSessionId: managed.id,
      workspacePath: rootPath,
      workingDirectory: rootPath,
    })).rejects.toThrow(/Cannot bind task "demo-task"/)

    expect(loadTaskSpec(rootPath, 'demo-task')).toBeNull()
  })

  it('task callbacks reject unsafe slugs/runIds before conductor or storage access', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'craft-task-callback-path-safety-'))
    const sm = new SessionManager()
    const managed = makeManaged(rootPath)
    const service = sm.getTaskConductorService()
    const originalRun = service.run.bind(service)
    let runCalls = 0

    service.run = (() => {
      runCalls += 1
      throw new Error('unsafe input reached conductor')
    }) as typeof service.run

    try {
      const taskTools = (sm as any).createSessionTaskToolCallbacks(managed)
      const invocation = {
        callerSessionId: managed.id,
        workspacePath: rootPath,
        workingDirectory: rootPath,
      }
      const unsafe = ['../x', 'a/../b', '/tmp/x', '..', '.', '', 'a%2Fb', 'a\\b']

      for (const value of unsafe) {
        expect(() => taskTools.run({ slug: value }, invocation)).toThrow(/Invalid task slug/)
        expect(() => taskTools.get({ slug: value }, invocation)).toThrow(/Invalid task slug/)
        expect(() => taskTools.getResults({ slug: value }, invocation)).toThrow(/Invalid task slug/)
        expect(() => taskTools.run({ slug: 'demo-task', runId: value }, invocation)).toThrow(/Invalid task run ID/)
        expect(() => taskTools.get({ slug: 'demo-task', runId: value }, invocation)).toThrow(/Invalid task run ID/)
        expect(() => taskTools.getResults({ slug: 'demo-task', runId: value }, invocation)).toThrow(/Invalid task run ID/)
      }

      expect(runCalls).toBe(0)
    } finally {
      service.run = originalRun
    }
  })

  it('task_run defaults the orchestrator/verifier to the caller and uses the shared conductor', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'craft-task-run-callbacks-'))
    const sm = new SessionManager()
    const managed = makeManaged(rootPath)
    const service = sm.getTaskConductorService()
    const originalRun = service.run.bind(service)
    const seen: unknown[] = []

    service.run = ((...args: unknown[]) => {
      seen.push(args)
      return {
        slug: 'demo-task',
        runId: 'run-from-service',
        taskId: 'demo-task',
        status: 'running',
        orchestratorSessionId: managed.id,
        nodes: [],
        tokensUsed: 0,
      }
    }) as typeof service.run

    try {
      const taskTools = (sm as any).createSessionTaskToolCallbacks(managed)
      const result = await taskTools.run({ slug: 'demo-task', runId: 'requested-run', params: { answer: 42 } }, {
        callerSessionId: managed.id,
        workspacePath: rootPath,
      })

      expect(result.orchestratorSessionId).toBe(managed.id)
      expect(seen).toEqual([[managed.workspace.id, 'demo-task', {
        runId: 'requested-run',
        orchestratorSessionId: managed.id,
        params: { answer: 42 },
      }]])
    } finally {
      service.run = originalRun
    }
  })

  it('renderer RPC and task-tool callbacks resolve the same TaskConductorService instance', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'craft-task-shared-conductor-'))
    const sm = new SessionManager()
    const managed = makeManaged(rootPath)
    const service = sm.getTaskConductorService()
    expect(service).toBe(getOrCreateTaskConductorService({ host: sm }))

    const originalRun = service.run.bind(service)
    let calls = 0
    service.run = ((workspaceId: string, slug: string, opts = {}) => {
      calls += 1
      return {
        slug,
        runId: (opts as { runId?: string }).runId ?? `run-${calls}`,
        taskId: slug,
        status: 'running',
        orchestratorSessionId: (opts as { orchestratorSessionId?: string }).orchestratorSessionId,
        nodes: [],
        tokensUsed: 0,
      }
    }) as typeof service.run

    try {
      const handlers = new Map<string, (...args: any[]) => unknown>()
      registerTasksHandlers({ handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) } as any, {
        sessionManager: sm as any,
      } as any)

      const rpcRun = handlers.get(RPC_CHANNELS.tasks.RUN)
      expect(rpcRun).toBeDefined()
      const fromRpc = await rpcRun!({}, managed.workspace.id, { slug: 'demo-task', runId: 'rpc-run', orchestratorSessionId: managed.id }) as { runId: string }
      const taskTools = (sm as any).createSessionTaskToolCallbacks(managed)
      const fromCallback = await taskTools.run({ slug: 'demo-task', runId: 'callback-run' }, {
        callerSessionId: managed.id,
        workspacePath: rootPath,
      }) as { runId: string }

      expect(fromRpc.runId).toBe('rpc-run')
      expect(fromCallback.runId).toBe('callback-run')
      expect(calls).toBe(2)
    } finally {
      service.run = originalRun
    }
  })
})
