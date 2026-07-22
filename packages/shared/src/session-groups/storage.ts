import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { CreateSessionGroupInput, SessionGroupConfig, SessionGroupsConfig } from './types.ts'
import { readJsonFileSync } from '../utils/files.ts'

const SESSION_GROUPS_FILE = 'session-groups.json'

function slugifyGroupId(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'group'
}

function uniqueGroupId(name: string, groups: SessionGroupConfig[]): string {
  const base = slugifyGroupId(name)
  const existing = new Set(groups.map(g => g.id))
  if (!existing.has(base)) return base
  let i = 2
  while (existing.has(`${base}-${i}`)) i += 1
  return `${base}-${i}`
}

function normalizeGroupsConfig(input: Partial<SessionGroupsConfig> | null | undefined): SessionGroupsConfig {
  const groups = Array.isArray(input?.groups) ? input!.groups : []
  return {
    version: 1,
    groups: groups
      .filter((g): g is SessionGroupConfig => Boolean(g && typeof g.id === 'string' && typeof g.name === 'string'))
      .map((g, index) => ({
        id: g.id,
        name: g.name,
        icon: typeof g.icon === 'string' ? g.icon : undefined,
        color: typeof g.color === 'string' ? g.color : undefined,
        createdAt: typeof g.createdAt === 'number' ? g.createdAt : Date.now(),
        order: typeof g.order === 'number' ? g.order : index,
      }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
  }
}

export function loadSessionGroupsConfig(workspaceRootPath: string): SessionGroupsConfig {
  const configPath = join(workspaceRootPath, SESSION_GROUPS_FILE)
  if (!existsSync(configPath)) return { version: 1, groups: [] }
  try {
    return normalizeGroupsConfig(readJsonFileSync<SessionGroupsConfig>(configPath))
  } catch {
    return { version: 1, groups: [] }
  }
}

export function saveSessionGroupsConfig(workspaceRootPath: string, config: SessionGroupsConfig): void {
  const configPath = join(workspaceRootPath, SESSION_GROUPS_FILE)
  writeFileSync(configPath, JSON.stringify(normalizeGroupsConfig(config), null, 2), 'utf-8')
}

export function listSessionGroups(workspaceRootPath: string): SessionGroupConfig[] {
  return loadSessionGroupsConfig(workspaceRootPath).groups
}

export function saveSessionGroups(workspaceRootPath: string, groups: SessionGroupConfig[]): void {
  saveSessionGroupsConfig(workspaceRootPath, { version: 1, groups })
}

export function createSessionGroup(workspaceRootPath: string, input: CreateSessionGroupInput): SessionGroupConfig {
  const config = loadSessionGroupsConfig(workspaceRootPath)
  const name = input.name.trim()
  if (!name) throw new Error('Group name is required')
  const nextOrder = config.groups.reduce((max, group) => Math.max(max, group.order), -1) + 1
  const group: SessionGroupConfig = {
    id: uniqueGroupId(name, config.groups),
    name,
    icon: input.icon?.trim() || undefined,
    color: input.color,
    createdAt: Date.now(),
    order: nextOrder,
  }
  config.groups.push(group)
  saveSessionGroupsConfig(workspaceRootPath, config)
  return group
}

export function deleteSessionGroup(workspaceRootPath: string, groupId: string): boolean {
  const config = loadSessionGroupsConfig(workspaceRootPath)
  const next = config.groups.filter(group => group.id !== groupId)
  if (next.length === config.groups.length) return false
  saveSessionGroupsConfig(workspaceRootPath, { version: 1, groups: next })
  return true
}
