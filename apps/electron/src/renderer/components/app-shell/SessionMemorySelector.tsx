import * as React from 'react'
import { Database } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import type { ProjectMemoryConnectionDetail, Session } from '@craft-agent/shared/protocol'
import type { MemorySpaceRef } from '@craft-agent/shared/project-memory/contracts'

interface SessionMemorySelectorProps {
  session: Session
}

function refKey(ref: MemorySpaceRef): string {
  return `${ref.connectionId}:${ref.spaceId}`
}

function sameRef(a: MemorySpaceRef | undefined, b: MemorySpaceRef): boolean {
  return !!a && a.connectionId === b.connectionId && a.spaceId === b.spaceId
}

export function SessionMemorySelector({ session }: SessionMemorySelectorProps) {
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [connections, setConnections] = React.useState<ProjectMemoryConnectionDetail[]>([])
  const [readRefs, setReadRefs] = React.useState<MemorySpaceRef[]>(session.enabledMemorySpaceRefs ?? [])
  const [writeRef, setWriteRef] = React.useState<MemorySpaceRef | undefined>(session.memoryWriteTargetRef)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    setReadRefs(session.enabledMemorySpaceRefs ?? [])
    setWriteRef(session.memoryWriteTargetRef)
  }, [session.enabledMemorySpaceRefs, session.memoryWriteTargetRef])

  const loadConnections = React.useCallback(async () => {
    setLoading(true)
    try {
      const snapshot = await window.electronAPI.getProjectMemoryConnectionsSnapshot()
      const details = await Promise.all(
        snapshot.connections
          .filter(connection => connection.enabled)
          .map(connection => window.electronAPI.getProjectMemoryConnection(connection.connectionId)),
      )
      setConnections(details)
    } catch (error) {
      console.error('[SessionMemorySelector] Failed to load memory connections:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to load memory connections')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (open) void loadConnections()
  }, [loadConnections, open])

  const selectedCount = readRefs.length + (writeRef ? 1 : 0)

  const toggleReadRef = React.useCallback((ref: MemorySpaceRef) => {
    setReadRefs(current => {
      const key = refKey(ref)
      if (current.some(item => refKey(item) === key)) {
        return current.filter(item => refKey(item) !== key)
      }
      return [...current, ref].sort((a, b) => refKey(a).localeCompare(refKey(b)))
    })
  }, [])

  const save = React.useCallback(async () => {
    setSaving(true)
    try {
      await window.electronAPI.sessionCommand(session.id, {
        type: 'setMemorySelection',
        enabledMemorySpaceRefs: readRefs.length > 0 ? readRefs : undefined,
        memoryWriteTargetRef: writeRef,
        memorySelectionMode: readRefs.length > 0 || writeRef ? 'explicit' : undefined,
      })
      toast.success('Session memory selection saved')
      setOpen(false)
    } catch (error) {
      console.error('[SessionMemorySelector] Failed to save memory selection:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to save memory selection')
    } finally {
      setSaving(false)
    }
  }, [readRefs, session.id, writeRef])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PanelHeaderCenterButton
          icon={<Database className="h-4 w-4" />}
          aria-label="Session memory selection"
          tooltip={selectedCount > 0 ? `Memory refs: ${selectedCount}` : 'Session memory'}
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[420px] p-0">
        <div className="border-b border-border/60 px-3 py-2">
          <div className="text-sm font-medium">Session memory</div>
          <div className="mt-0.5 text-xs text-muted-foreground">Choose spaces this session can read from and optionally write to.</div>
        </div>
        <div className="max-h-[360px] overflow-auto p-3">
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading memory connections…</div>
          ) : connections.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No enabled memory connections.</div>
          ) : (
            <div className="space-y-3">
              {connections.map(connection => (
                <div key={connection.connectionId} className="rounded-lg border border-border/60 p-2">
                  <div className="mb-2 min-w-0">
                    <div className="truncate text-sm font-medium">{connection.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{connection.collection} · {connection.url}</div>
                  </div>
                  <div className="space-y-1">
                    {connection.spaces.map(space => {
                      const ref = { connectionId: connection.connectionId, spaceId: space.spaceId }
                      const checked = readRefs.some(item => sameRef(item, ref))
                      const writable = space.writable === true && !space.readOnly && space.kind !== 'global'
                      return (
                        <div key={space.spaceId} className="flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-foreground/5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleReadRef(ref)}
                            aria-label={`Read from ${space.name}`}
                          />
                          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => toggleReadRef(ref)}>
                            <span className="font-medium">{space.name}</span>
                            <span className="ml-1 text-muted-foreground">({space.kind})</span>
                          </button>
                          {writable && (
                            <label className="flex items-center gap-1 text-muted-foreground">
                              <input
                                type="radio"
                                name={`memory-write-${session.id}`}
                                checked={sameRef(writeRef, ref)}
                                onChange={() => setWriteRef(ref)}
                              />
                              write
                            </label>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-between gap-2 border-t border-border/60 p-3">
          <Button variant="ghost" size="sm" onClick={() => { setReadRefs([]); setWriteRef(undefined) }} disabled={saving}>
            Clear
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={loadConnections} disabled={loading || saving}>Refresh</Button>
            <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
