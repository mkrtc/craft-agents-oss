import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setConfigDirForTests } from '../paths'
import { detachWorkspaceConfig, loadStoredConfig, saveConfig } from '../storage'

let root: string | undefined

afterEach(() => {
  __setConfigDirForTests(null)
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('detachWorkspaceConfig', () => {
  it('detaches config last-step data without deleting managed-root or custom-root files', () => {
    root = mkdtempSync(join(tmpdir(), 'craft-workspace-detach-'))
    const configDir = join(root, 'config')
    const managedRoot = join(configDir, 'workspaces', 'managed')
    const customRoot = join(root, 'custom-workspace')
    mkdirSync(managedRoot, { recursive: true })
    mkdirSync(customRoot, { recursive: true })
    const managedSession = join(managedRoot, 'sessions', 'session-a', 'session.jsonl')
    const managedProject = join(managedRoot, 'projects', 'project-a', 'config.json')
    const customSession = join(customRoot, 'sessions', 'session-b', 'session.jsonl')
    const customProject = join(customRoot, 'projects', 'project-b', 'config.json')
    for (const path of [managedSession, managedProject, customSession, customProject]) {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'preserve-me')
    }

    __setConfigDirForTests(configDir)
    saveConfig({
      workspaces: [
        { id: 'managed', name: 'Managed', slug: 'managed', rootPath: managedRoot, createdAt: 1 },
        { id: 'custom', name: 'Custom', slug: 'custom', rootPath: customRoot, createdAt: 2 },
      ],
      activeWorkspaceId: 'managed',
      activeSessionId: null,
    })

    expect(detachWorkspaceConfig('managed')).toBe(true)
    expect(loadStoredConfig()?.workspaces.map((workspace) => workspace.id)).toEqual(['custom'])
    expect(loadStoredConfig()?.activeWorkspaceId).toBe('custom')
    for (const path of [managedSession, managedProject, customSession, customProject]) {
      expect(existsSync(path)).toBe(true)
    }

    expect(detachWorkspaceConfig('custom')).toBe(true)
    expect(loadStoredConfig()?.workspaces).toEqual([])
    expect(loadStoredConfig()?.activeWorkspaceId).toBeNull()
    for (const path of [managedSession, managedProject, customSession, customProject]) {
      expect(existsSync(path)).toBe(true)
    }
  })
})
