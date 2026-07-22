import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createSessionGroup,
  deleteSessionGroup,
  listSessionGroups,
  loadSessionGroupsConfig,
  saveSessionGroups,
} from '../storage'

function withWorkspace(fn: (workspaceRoot: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'craft-session-groups-'))
  try {
    mkdirSync(root, { recursive: true })
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('session-groups storage', () => {
  test('loads an empty v1 config when file is missing', () => {
    withWorkspace((root) => {
      expect(loadSessionGroupsConfig(root)).toEqual({ version: 1, groups: [] })
    })
  })

  test('creates, lists, replaces, and deletes groups', () => {
    withWorkspace((root) => {
      const first = createSessionGroup(root, { name: 'Support' })
      const second = createSessionGroup(root, { name: 'Sales' })

      expect(listSessionGroups(root).map(g => g.name)).toEqual(['Support', 'Sales'])
      expect(second.order).toBe(1)

      saveSessionGroups(root, [{ ...second, order: 0 }])
      expect(listSessionGroups(root)).toEqual([{ ...second, order: 0 }])

      deleteSessionGroup(root, second.id)
      expect(listSessionGroups(root)).toEqual([])
      expect(first.id).toBe('support')
    })
  })
})
