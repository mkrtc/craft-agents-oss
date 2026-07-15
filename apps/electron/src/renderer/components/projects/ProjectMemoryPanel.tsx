import * as React from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Database, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type {
  ProjectMemoryUiPayload,
  ProjectMemoryUiSearchHit,
  ProjectMemoryUiSource,
  ProjectMemoryConnectionSnapshot,
  ProjectMemoryConnectionSummary,
  ProjectMemoryUiStatus,
} from '@craft-agent/shared/protocol'

const CONTENT_MAX_LENGTH = 8000
const SEARCH_LIMIT = 8

type ProjectMemoryPanelProps = {
  projectIdOrSlug: string
}

export function ProjectMemoryPanel({ projectIdOrSlug }: ProjectMemoryPanelProps) {
  const { t } = useTranslation()
  const [status, setStatus] = React.useState<ProjectMemoryUiStatus | null>(null)
  const [statusLoading, setStatusLoading] = React.useState(true)
  const [statusError, setStatusError] = React.useState<string | null>(null)

  const [connectionsSnapshot, setConnectionsSnapshot] = React.useState<ProjectMemoryConnectionSnapshot | null>(null)
  const [connectionsLoading, setConnectionsLoading] = React.useState(true)
  const [connectionsError, setConnectionsError] = React.useState<string | null>(null)
  const [connectionName, setConnectionName] = React.useState('')
  const [connectionUrl, setConnectionUrl] = React.useState('')
  const [connectionCollection, setConnectionCollection] = React.useState('craft_memory')
  const [creatingConnection, setCreatingConnection] = React.useState(false)
  const [mutatingConnectionId, setMutatingConnectionId] = React.useState<string | null>(null)

  const [source, setSource] = React.useState<ProjectMemoryUiSource>('manual-note')
  const [title, setTitle] = React.useState('')
  const [content, setContent] = React.useState('')
  const [tags, setTags] = React.useState('')
  const [adding, setAdding] = React.useState(false)

  const [query, setQuery] = React.useState('')
  const [searching, setSearching] = React.useState(false)
  const [searchAttempted, setSearchAttempted] = React.useState(false)
  const [results, setResults] = React.useState<ProjectMemoryUiSearchHit[]>([])

  const loadStatus = React.useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      const nextStatus = await window.electronAPI.getProjectMemoryStatus()
      setStatus(nextStatus)
    } catch (err) {
      console.error('[ProjectMemoryPanel] Failed to load memory status:', err)
      setStatus(null)
      setStatusError(err instanceof Error ? err.message : String(err))
    } finally {
      setStatusLoading(false)
    }
  }, [])

  const loadConnections = React.useCallback(async () => {
    setConnectionsLoading(true)
    setConnectionsError(null)
    try {
      setConnectionsSnapshot(await window.electronAPI.getProjectMemoryConnectionsSnapshot())
    } catch (err) {
      console.error('[ProjectMemoryPanel] Failed to load memory connections:', err)
      setConnectionsSnapshot(null)
      setConnectionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnectionsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    loadStatus()
    loadConnections()
  }, [loadConnections, loadStatus])

  const ready = status?.state === 'ready'
  const sanitizedTags = React.useMemo(() => sanitizeTags(tags), [tags])

  const handleAdd = React.useCallback(async () => {
    const trimmedContent = content.trim()
    if (!trimmedContent) {
      toast.error(t('projectInfo.memory.addContentRequired'))
      return
    }
    if (trimmedContent.length > CONTENT_MAX_LENGTH) {
      toast.error(t('projectInfo.memory.addContentTooLong', { max: CONTENT_MAX_LENGTH }))
      return
    }

    setAdding(true)
    try {
      await window.electronAPI.addProjectMemory({
        projectIdOrSlug,
        source,
        title: title.trim() || undefined,
        content: trimmedContent,
        tags: sanitizedTags.length > 0 ? sanitizedTags : undefined,
      })
      toast.success(t('projectInfo.memory.addSuccess'))
      setTitle('')
      setContent('')
      setTags('')
    } catch (err) {
      console.error('[ProjectMemoryPanel] Failed to add memory:', err)
      toast.error(t('projectInfo.memory.addFailed'))
    } finally {
      setAdding(false)
    }
  }, [content, projectIdOrSlug, sanitizedTags, source, t, title])

  const handleSearch = React.useCallback(async () => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      toast.error(t('projectInfo.memory.searchQueryRequired'))
      return
    }

    setSearching(true)
    setSearchAttempted(true)
    try {
      const hits = await window.electronAPI.searchProjectMemory({
        projectIdOrSlug,
        query: trimmedQuery,
        limit: SEARCH_LIMIT,
      })
      setResults(Array.isArray(hits) ? hits : [])
    } catch (err) {
      console.error('[ProjectMemoryPanel] Failed to search memory:', err)
      toast.error(t('projectInfo.memory.searchFailed'))
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [projectIdOrSlug, query, t])

  const handleCreateConnection = React.useCallback(async () => {
    const name = connectionName.trim()
    const url = connectionUrl.trim()
    const collection = connectionCollection.trim()
    if (!name || !url || !collection) {
      toast.error('Connection name, URL, and collection are required')
      return
    }

    setCreatingConnection(true)
    try {
      await window.electronAPI.createProjectMemoryConnection({
        expectedRootRevision: connectionsSnapshot?.revision ?? 0,
        name,
        url,
        collection,
        embedding: { model: 'craft-local-hash-v1', dimension: status?.dimension || 384 },
        enabled: true,
        proactiveRemoteSearch: false,
      })
      toast.success('Memory connection created')
      setConnectionName('')
      setConnectionUrl('')
      setConnectionCollection('craft_memory')
      await Promise.all([loadConnections(), loadStatus()])
    } catch (err) {
      console.error('[ProjectMemoryPanel] Failed to create memory connection:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to create memory connection')
    } finally {
      setCreatingConnection(false)
    }
  }, [connectionCollection, connectionName, connectionUrl, connectionsSnapshot?.revision, loadConnections, loadStatus, status?.dimension])

  const handleToggleConnection = React.useCallback(async (connection: ProjectMemoryConnectionSummary) => {
    setMutatingConnectionId(connection.connectionId)
    try {
      await window.electronAPI.updateProjectMemoryConnection({
        connectionId: connection.connectionId,
        expectedRevision: connection.revision,
        enabled: !connection.enabled,
      })
      toast.success(connection.enabled ? 'Memory connection disabled' : 'Memory connection enabled')
      await Promise.all([loadConnections(), loadStatus()])
    } catch (err) {
      console.error('[ProjectMemoryPanel] Failed to update memory connection:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to update memory connection')
    } finally {
      setMutatingConnectionId(null)
    }
  }, [loadConnections, loadStatus])

  const handleDeleteConnection = React.useCallback(async (connection: ProjectMemoryConnectionSummary) => {
    if (!window.confirm(`Delete memory connection "${connection.name}"?`)) return
    setMutatingConnectionId(connection.connectionId)
    try {
      await window.electronAPI.deleteProjectMemoryConnection({
        connectionId: connection.connectionId,
        expectedRootRevision: connectionsSnapshot?.revision ?? 0,
      })
      toast.success('Memory connection deleted')
      await Promise.all([loadConnections(), loadStatus()])
    } catch (err) {
      console.error('[ProjectMemoryPanel] Failed to delete memory connection:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to delete memory connection')
    } finally {
      setMutatingConnectionId(null)
    }
  }, [connectionsSnapshot?.revision, loadConnections, loadStatus])

  return (
    <div className="space-y-4 px-4 py-3">
      <StatusCard
        status={status}
        loading={statusLoading}
        error={statusError}
        onRefresh={loadStatus}
      />

      <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200 flex gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t('projectInfo.memory.secretWarning')}</span>
      </div>

      {!ready && (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground">
          {t('projectInfo.memory.disabledHint')}
        </div>
      )}

      <MemoryConnectionsSection
        snapshot={connectionsSnapshot}
        loading={connectionsLoading}
        error={connectionsError}
        name={connectionName}
        url={connectionUrl}
        collection={connectionCollection}
        creating={creatingConnection}
        mutatingConnectionId={mutatingConnectionId}
        onNameChange={setConnectionName}
        onUrlChange={setConnectionUrl}
        onCollectionChange={setConnectionCollection}
        onRefresh={loadConnections}
        onCreate={handleCreateConnection}
        onToggle={handleToggleConnection}
        onDelete={handleDeleteConnection}
      />

      <section className="rounded-lg border border-border/60 bg-background/50">
        <div className="border-b border-border/50 px-4 py-3">
          <h3 className="text-sm font-medium">{t('projectInfo.memory.addTitle')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('projectInfo.memory.addDescription')}</p>
        </div>
        <div className="space-y-3 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('projectInfo.memory.sourceLabel')}>
              <Select value={source} onValueChange={(value) => setSource(value as ProjectMemoryUiSource)} disabled={!ready || adding}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual-note">{t('projectInfo.memory.sourceManualNote')}</SelectItem>
                  <SelectItem value="decision">{t('projectInfo.memory.sourceDecision')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('projectInfo.memory.titleLabel')}>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('projectInfo.memory.titlePlaceholder')}
                disabled={!ready || adding}
              />
            </Field>
          </div>

          <Field label={t('projectInfo.memory.contentLabel')}>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value.slice(0, CONTENT_MAX_LENGTH))}
              placeholder={t('projectInfo.memory.contentPlaceholder')}
              rows={6}
              maxLength={CONTENT_MAX_LENGTH}
              disabled={!ready || adding}
            />
            <div className="mt-1 text-right text-xs text-muted-foreground">
              {t('projectInfo.memory.charactersRemaining', {
                remaining: Math.max(0, CONTENT_MAX_LENGTH - content.length),
                max: CONTENT_MAX_LENGTH,
              })}
            </div>
          </Field>

          <Field label={t('projectInfo.memory.tagsLabel')} hint={t('projectInfo.memory.tagsHint')}>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              onBlur={() => setTags(sanitizedTags.join(', '))}
              placeholder={t('projectInfo.memory.tagsPlaceholder')}
              disabled={!ready || adding}
            />
          </Field>

          <div className="flex justify-end">
            <Button onClick={handleAdd} disabled={!ready || adding || !content.trim()}>
              {adding ? t('projectInfo.memory.adding') : t('projectInfo.memory.addButton')}
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border/60 bg-background/50">
        <div className="border-b border-border/50 px-4 py-3">
          <h3 className="text-sm font-medium">{t('projectInfo.memory.searchTitle')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('projectInfo.memory.searchDescription', { limit: SEARCH_LIMIT })}</p>
        </div>
        <div className="space-y-3 p-4">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSearch()
              }}
              placeholder={t('projectInfo.memory.searchPlaceholder')}
              disabled={!ready || searching}
              className="flex-1"
            />
            <Button onClick={handleSearch} disabled={!ready || searching || !query.trim()}>
              <Search className="mr-1.5 h-3.5 w-3.5" />
              {searching ? t('projectInfo.memory.searching') : t('projectInfo.memory.searchButton')}
            </Button>
          </div>

          {searchAttempted && !searching && results.length === 0 && (
            <div className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
              {t('projectInfo.memory.noResults')}
            </div>
          )}

          {results.length > 0 && (
            <ul className="space-y-2">
              {results.map((hit) => (
                <MemoryResult key={hit.payload.id} hit={hit} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}


function MemoryConnectionsSection({
  snapshot,
  loading,
  error,
  name,
  url,
  collection,
  creating,
  mutatingConnectionId,
  onNameChange,
  onUrlChange,
  onCollectionChange,
  onRefresh,
  onCreate,
  onToggle,
  onDelete,
}: {
  snapshot: ProjectMemoryConnectionSnapshot | null
  loading: boolean
  error: string | null
  name: string
  url: string
  collection: string
  creating: boolean
  mutatingConnectionId: string | null
  onNameChange: (value: string) => void
  onUrlChange: (value: string) => void
  onCollectionChange: (value: string) => void
  onRefresh: () => void
  onCreate: () => void
  onToggle: (connection: ProjectMemoryConnectionSummary) => void
  onDelete: (connection: ProjectMemoryConnectionSummary) => void
}) {
  const connections = snapshot?.connections ?? []

  return (
    <section className="rounded-lg border border-border/60 bg-background/50">
      <div className="flex items-start justify-between gap-3 border-b border-border/50 px-4 py-3">
        <div>
          <h3 className="text-sm font-medium">Memory connections</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Manage Qdrant connections used by project memory. API keys are never shown here.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onRefresh} disabled={loading}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      <div className="space-y-4 p-4">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-[1fr_1.4fr_1fr_auto]">
          <Field label="Name">
            <Input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="Primary Qdrant" disabled={creating} />
          </Field>
          <Field label="URL">
            <Input value={url} onChange={(e) => onUrlChange(e.target.value)} placeholder="https://qdrant.example" disabled={creating} />
          </Field>
          <Field label="Collection">
            <Input value={collection} onChange={(e) => onCollectionChange(e.target.value)} placeholder="craft_memory" disabled={creating} />
          </Field>
          <div className="flex items-end">
            <Button onClick={onCreate} disabled={creating || !name.trim() || !url.trim() || !collection.trim()}>
              {creating ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </div>

        {loading && !snapshot ? (
          <div className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            Loading memory connections…
          </div>
        ) : connections.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            No memory connections configured.
          </div>
        ) : (
          <ul className="space-y-2">
            {connections.map((connection) => {
              const mutating = mutatingConnectionId === connection.connectionId
              return (
                <li key={connection.connectionId} className="rounded-lg border border-border/60 bg-background p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="truncate text-sm font-medium">{connection.name}</h4>
                        <span className={connection.enabled ? 'rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300' : 'rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] text-foreground/60'}>
                          {connection.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                        {connection.isEnvironment && (
                          <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] text-foreground/60">Environment</span>
                        )}
                        <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] text-foreground/60">
                          {connection.hasApiKey ? 'API key stored' : 'No API key'}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-1 text-xs text-muted-foreground md:grid-cols-2">
                        <span className="truncate">URL: {connection.url}</span>
                        <span className="truncate">Collection: {connection.collection}</span>
                        <span>Embedding: {connection.embedding.model}:{connection.embedding.dimension}</span>
                        <span>Revision: {connection.revision} · Spaces: {connection.spaceCount}</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => onToggle(connection)} disabled={connection.isEnvironment || mutating}>
                        {connection.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onDelete(connection)} disabled={connection.isEnvironment || mutating}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}

function StatusCard({
  status,
  loading,
  error,
  onRefresh,
}: {
  status: ProjectMemoryUiStatus | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  const copy = getStatusCopy(status, error, t)

  return (
    <div className="rounded-lg border border-border/60 bg-background/50 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-foreground/5 p-2">
          <Database className="h-4 w-4 text-foreground/70" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{t('projectInfo.memory.statusTitle')}</h3>
            <span className={statusBadgeClass(status?.state)}>
              {loading ? t('projectInfo.memory.statusLoading') : copy.label}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{loading ? t('projectInfo.memory.statusLoadingDescription') : copy.description}</p>
          {status && (
            <div className="mt-3 grid gap-2 text-xs text-muted-foreground md:grid-cols-3">
              <MetadataItem label={t('projectInfo.memory.provider')} value={status.provider} />
              <MetadataItem label={t('projectInfo.memory.collection')} value={status.collection || '—'} />
              <MetadataItem label={t('projectInfo.memory.dimension')} value={String(status.dimension || '—')} />
            </div>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={onRefresh} disabled={loading}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {t('projectInfo.memory.refreshStatus')}
        </Button>
      </div>
    </div>
  )
}

function MemoryResult({ hit }: { hit: ProjectMemoryUiSearchHit }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = React.useState(false)
  const payload = hit.payload
  const hasLongContent = payload.content.length > 260
  const shownContent = expanded || !hasLongContent ? payload.content : `${payload.content.slice(0, 260).trimEnd()}…`

  return (
    <li className="rounded-lg border border-border/60 bg-background p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium text-foreground">
              {payload.title || t('projectInfo.memory.untitled')}
            </h4>
            <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] text-foreground/70">
              {sourceLabel(payload.source, t)}
            </span>
            <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] text-foreground/70">
              {t('projectInfo.memory.score', { score: hit.score.toFixed(3) })}
            </span>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/75">
            {shownContent}
          </p>
          {hasLongContent && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="mt-1 inline-flex items-center gap-1 text-xs text-foreground/60 hover:text-foreground"
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {expanded ? t('projectInfo.memory.showLess') : t('projectInfo.memory.showMore')}
            </button>
          )}
          {payload.tags && payload.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {payload.tags.map((tag) => (
                <span key={tag} className="rounded bg-foreground/5 px-1.5 py-0.5 text-[11px] text-foreground/60">
                  {tag}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground md:grid-cols-2">
            <span>{t('projectInfo.memory.createdAt', { value: formatTimestamp(payload.createdAt) })}</span>
            <span>{t('projectInfo.memory.updatedAt', { value: formatTimestamp(payload.updatedAt) })}</span>
            <span className="truncate">{t('projectInfo.memory.resultId', { id: payload.id })}</span>
            <span className="truncate">{t('projectInfo.memory.projectId', { id: payload.projectId })}</span>
          </div>
        </div>
      </div>
    </li>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-foreground/70">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-foreground/50">{hint}</div>}
    </label>
  )
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-foreground/45">{label}</div>
      <div className="truncate font-mono">{value}</div>
    </div>
  )
}

function sanitizeTags(value: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const rawTag of value.split(',')) {
    const tag = rawTag.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase()
    if (tag && !seen.has(tag)) {
      seen.add(tag)
      result.push(tag)
    }
  }
  return result.slice(0, 12)
}

function sourceLabel(source: ProjectMemoryUiSource, t: (key: string) => string): string {
  switch (source) {
    case 'decision':
      return t('projectInfo.memory.sourceDecision')
    case 'manual-note':
    default:
      return t('projectInfo.memory.sourceManualNote')
  }
}

function getStatusCopy(status: ProjectMemoryUiStatus | null, error: string | null, t: (key: string, options?: Record<string, unknown>) => string) {
  if (error) {
    return {
      label: t('projectInfo.memory.statusError'),
      description: error,
    }
  }

  switch (status?.state) {
    case 'ready':
      return {
        label: t('projectInfo.memory.statusReady'),
        description: status.message || t('projectInfo.memory.statusReadyDescription'),
      }
    case 'disabled':
      return {
        label: t('projectInfo.memory.statusDisabled'),
        description: status.message || t('projectInfo.memory.statusDisabledDescription'),
      }
    case 'not-initialized':
      return {
        label: t('projectInfo.memory.statusNotInitialized'),
        description: status.message || t('projectInfo.memory.statusNotInitializedDescription'),
      }
    case 'config-mismatch':
      return {
        label: t('projectInfo.memory.statusConfigMismatch'),
        description: status.message || t('projectInfo.memory.statusConfigMismatchDescription'),
      }
    case 'unreachable':
      return {
        label: t('projectInfo.memory.statusUnreachable'),
        description: status.error || status.message || t('projectInfo.memory.statusUnreachableDescription'),
      }
    case 'error':
      return {
        label: t('projectInfo.memory.statusError'),
        description: status.error || status.message || t('projectInfo.memory.statusErrorDescription'),
      }
    default:
      return {
        label: t('projectInfo.memory.statusUnknown'),
        description: t('projectInfo.memory.statusUnknownDescription'),
      }
  }
}

function statusBadgeClass(state?: ProjectMemoryUiStatus['state']): string {
  const base = 'rounded-full px-2 py-0.5 text-[11px] font-medium'
  switch (state) {
    case 'ready':
      return `${base} bg-emerald-500/10 text-emerald-700 dark:text-emerald-300`
    case 'disabled':
    case 'not-initialized':
      return `${base} bg-foreground/5 text-foreground/60`
    case 'config-mismatch':
    case 'unreachable':
      return `${base} bg-amber-500/10 text-amber-700 dark:text-amber-300`
    case 'error':
      return `${base} bg-destructive/10 text-destructive`
    default:
      return `${base} bg-foreground/5 text-foreground/60`
  }
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  return new Date(value).toLocaleString()
}
