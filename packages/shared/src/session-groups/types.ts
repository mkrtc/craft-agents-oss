/** Workspace-scoped custom chat group shown in the session list. */
export interface SessionGroupConfig {
  id: string
  name: string
  icon?: string
  color?: string
  createdAt: number
  order: number
}

export interface SessionGroupsConfig {
  version: number
  groups: SessionGroupConfig[]
}

export interface CreateSessionGroupInput {
  name: string
  icon?: string
  color?: string
}
