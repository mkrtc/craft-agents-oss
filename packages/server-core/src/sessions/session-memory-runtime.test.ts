import { describe, expect, it } from 'bun:test'
import type { ManagedMemoryConnectionDescriptor } from '@craft-agent/shared/project-memory/contracts'
import {
  formatSessionMemorySelectionDeniedReason,
  resolveSessionManagedMemorySelection,
} from './session-memory-runtime'

type Deny = ReturnType<typeof resolveSessionManagedMemorySelection>['deniedRefs'][number]

const CONN = '123e4567-e89b-42d3-8456-426614174000'
const GLOBAL = 'aaaaaaaa-1111-4000-8000-000000000001'
const WORKSPACE = 'aaaaaaaa-1111-4000-8000-000000000002'
const PROJECT = 'aaaaaaaa-1111-4000-8000-000000000003'

describe('Session memory runtime selection helpers', () => {
  it('returns no resolution and no credential callbacks when no explicit refs are configured', () => {
    const descriptors: ManagedMemoryConnectionDescriptor[] = [
      {
        connectionId: CONN,
        enabled: true,
        spaces: [
          { spaceId: GLOBAL, kind: 'global', writable: false },
          { spaceId: WORKSPACE, kind: 'workspace', writable: true, workspaceId: 'ws-1' },
        ],
      },
    ]
    const callbacks: string[] = []

    const result = resolveSessionManagedMemorySelection(descriptors, {
      workspaceId: 'ws-1',
      enabledMemorySpaceRefs: [],
      memoryWriteTargetRef: undefined,
    }, {
      loadCredential: id => {
        callbacks.push(id)
      },
    })

    expect(result.readRefs).toEqual([])
    expect(result.writeRef).toBeUndefined()
    expect(result.deniedRefs).toEqual([])
    expect(callbacks).toEqual([])
  })

  it('rejects invalid write targets while still resolving allowed reads', () => {
    const descriptors: ManagedMemoryConnectionDescriptor[] = [
      {
        connectionId: CONN,
        enabled: true,
        spaces: [
          { spaceId: GLOBAL, kind: 'global', writable: true },
          { spaceId: WORKSPACE, kind: 'workspace', writable: true, workspaceId: 'ws-1' },
          { spaceId: PROJECT, kind: 'project', writable: true, workspaceId: 'ws-1', projectId: 'pr-1' },
        ],
      },
    ]
    const callbacks: string[] = []

    const result = resolveSessionManagedMemorySelection(
      descriptors,
      {
        workspaceId: 'ws-1',
        projectId: 'pr-1',
        enabledMemorySpaceRefs: [{ connectionId: CONN, spaceId: WORKSPACE }],
        memoryWriteTargetRef: { connectionId: CONN, spaceId: GLOBAL },
      },
      {
        loadCredential: id => {
          callbacks.push(id)
        },
      },
    )

    const denied: Deny = {
      code: 'global-space-write-forbidden',
      ref: { connectionId: CONN, spaceId: GLOBAL },
    }

    expect(result.deniedRefs).toEqual([denied])
    expect(result.readRefs).toEqual([
      {
        connectionId: CONN,
        spaceId: WORKSPACE,
        kind: 'workspace',
        writable: true,
      },
    ])
    expect(result.writeRef).toBeUndefined()
    expect(formatSessionMemorySelectionDeniedReason(denied)).toContain('global-space-write-forbidden')
    expect(callbacks).toEqual([CONN])
  })

  it('rejects non-member references without invoking credential callbacks', () => {
    const descriptors: ManagedMemoryConnectionDescriptor[] = [
      {
        connectionId: CONN,
        enabled: true,
        spaces: [
          {
            spaceId: 'aaaaaaaa-1111-4000-8000-000000000004',
            kind: 'custom',
            writable: true,
            workspaceId: 'ws-other',
          },
        ],
      },
    ]
    const callbacks: string[] = []

    const result = resolveSessionManagedMemorySelection(
      descriptors,
      {
        workspaceId: 'ws-1',
        enabledMemorySpaceRefs: [{ connectionId: CONN, spaceId: 'aaaaaaaa-1111-4000-8000-000000000004' }],
      },
      {
        loadCredential: id => {
          callbacks.push(id)
        },
      },
    )

    const denied: Deny = {
      code: 'not-member',
      ref: { connectionId: CONN, spaceId: 'aaaaaaaa-1111-4000-8000-000000000004' },
    }

    expect(result.deniedRefs).toEqual([denied])
    expect(result.readRefs).toEqual([])
    expect(result.writeRef).toBeUndefined()
    expect(callbacks).toEqual([])
  })

  it('rejects disabled connections and avoids credential callbacks', () => {
    const callbacks: string[] = []

    const result = resolveSessionManagedMemorySelection(
      [
        {
          connectionId: CONN,
          enabled: false,
          spaces: [
            { spaceId: WORKSPACE, kind: 'workspace', writable: true, workspaceId: 'ws-1' },
            { spaceId: PROJECT, kind: 'project', writable: true, workspaceId: 'ws-1', projectId: 'pr-1' },
          ],
        },
      ],
      {
        workspaceId: 'ws-1',
        projectId: 'pr-1',
        enabledMemorySpaceRefs: [{ connectionId: CONN, spaceId: WORKSPACE }],
        memoryWriteTargetRef: { connectionId: CONN, spaceId: PROJECT },
      },
      {
        loadCredential: id => {
          callbacks.push(id)
        },
      },
    )

    const denied: Deny = {
      code: 'connection-disabled',
      ref: { connectionId: CONN, spaceId: PROJECT },
    }

    expect(result.deniedRefs).toEqual([
      { code: 'connection-disabled', ref: { connectionId: CONN, spaceId: WORKSPACE } },
      denied,
    ])
    expect(result.readRefs).toEqual([])
    expect(result.writeRef).toBeUndefined()
    expect(callbacks).toEqual([])
  })

  it('invokes credential lookup only for allowed connection IDs', () => {
    const callbacks: string[] = []
    const result = resolveSessionManagedMemorySelection(
      [
        {
          connectionId: CONN,
          enabled: true,
          spaces: [
            { spaceId: GLOBAL, kind: 'global', writable: false },
            { spaceId: WORKSPACE, kind: 'workspace', writable: true, workspaceId: 'ws-1' },
            { spaceId: PROJECT, kind: 'project', writable: true, workspaceId: 'ws-1', projectId: 'pr-1' },
          ],
        },
      ],
      {
        workspaceId: 'ws-1',
        projectId: 'pr-1',
        enabledMemorySpaceRefs: [{ connectionId: CONN, spaceId: WORKSPACE }],
        memoryWriteTargetRef: { connectionId: CONN, spaceId: PROJECT },
      },
      {
        loadCredential: id => {
          callbacks.push(id)
        },
      },
    )

    expect(result.deniedRefs).toEqual([])
    expect(result.readRefs).toEqual([
      {
        connectionId: CONN,
        spaceId: WORKSPACE,
        kind: 'workspace',
        writable: true,
      },
    ])
    expect(result.writeRef).toEqual({
      connectionId: CONN,
      spaceId: PROJECT,
      kind: 'project',
      writable: true,
    })
    expect(callbacks).toEqual([CONN])
  })
})
