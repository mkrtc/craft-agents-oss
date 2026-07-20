/**
 * Playground registry entry for LabelBadgeRow.
 *
 * Demonstrates label value badges with interactive editing:
 * - Boolean labels (no value)
 * - Number-valued labels
 * - Date-valued labels
 * - String-valued labels
 * - Popover editing (click badge → edit value / remove)
 */

import * as React from 'react'
import type { ComponentEntry } from './types'
import type { CreateLabelInput, LabelConfig } from '@craft-agent/shared/labels'
import { LabelBadgeRow } from '@/components/ui/label-badge-row'
import { CreateLabelDialog } from '@/components/labels/CreateLabelDialog'
import { Button } from '@/components/ui/button'
import { LabelIcon } from '@/components/ui/label-icon'
import { ModalProvider } from '@/context/ModalContext'

// ============================================================================
// Mock label configurations matching the workspace format
// ============================================================================

const MOCK_LABELS: LabelConfig[] = [
  { id: 'bug', name: 'Bug', color: { light: '#EF4444', dark: '#F87171' } },
  { id: 'priority', name: 'Priority', color: { light: '#F59E0B', dark: '#FBBF24' }, valueType: 'number' },
  { id: 'due-date', name: 'Due Date', color: { light: '#3B82F6', dark: '#60A5FA' }, valueType: 'date' },
  { id: 'sprint', name: 'Sprint', color: { light: '#8B5CF6', dark: '#A78BFA' }, valueType: 'string' },
  { id: 'feature', name: 'Feature', color: { light: '#10B981', dark: '#34D399' } },
  { id: 'estimate', name: 'Estimate', color: { light: '#EC4899', dark: '#F472B6' }, valueType: 'number' },
  { id: 'docs', name: 'Docs', color: { light: '#0EA5E9', dark: '#38BDF8' }, valueType: 'link' },
]

// ============================================================================
// Playground Wrapper Component
// ============================================================================

interface LabelBadgeRowPlaygroundProps {
  showValues: boolean
  labelCount: number
}

function LabelBadgeRowPlayground({ showValues, labelCount }: LabelBadgeRowPlaygroundProps) {
  // Build initial session labels based on props
  const initialLabels = React.useMemo(() => {
    const base: string[] = []
    const configs = MOCK_LABELS.slice(0, Math.max(1, labelCount))

    for (const config of configs) {
      if (!showValues || !config.valueType) {
        // Boolean label — just the ID
        base.push(config.id)
      } else {
        // Valued label — add a sample value
        switch (config.valueType) {
          case 'number':
            base.push(`${config.id}::${config.id === 'priority' ? '3' : '5'}`)
            break
          case 'date':
            base.push(`${config.id}::2026-02-01`)
            break
          case 'string':
            base.push(`${config.id}::Q1-Sprint-3`)
            break
          case 'link':
            base.push(`${config.id}::https://example.com/docs/getting-started`)
            break
        }
      }
    }
    return base
  }, [showValues, labelCount])

  const [sessionLabels, setSessionLabels] = React.useState<string[]>(initialLabels)

  // Reset when props change
  React.useEffect(() => {
    setSessionLabels(initialLabels)
  }, [initialLabels])

  return (
    <div className="w-[500px] rounded-[12px] border border-border bg-sidebar overflow-hidden">
      {/* Simulated input area header */}
      <LabelBadgeRow
        sessionLabels={sessionLabels}
        labels={MOCK_LABELS}
        onLabelsChange={setSessionLabels}
      />
      {/* Simulated input area */}
      <div className="px-5 py-4 min-h-[80px] text-foreground/30 text-[14px]">
        Message...
      </div>
      {/* Simulated bottom bar */}
      <div className="border-t border-border/50 px-3 py-2 flex items-center">
        <span className="text-[12px] text-foreground/40">
          {sessionLabels.length} label{sessionLabels.length !== 1 ? 's' : ''} applied
        </span>
      </div>
    </div>
  )
}

function insertPlaygroundLabel(labels: LabelConfig[], parentId: string | undefined, created: LabelConfig): LabelConfig[] {
  if (!parentId) return [...labels, created]
  return labels.map(label => label.id === parentId
    ? { ...label, children: [...(label.children ?? []), created] }
    : { ...label, children: label.children ? insertPlaygroundLabel(label.children, parentId, created) : undefined })
}

function flattenPlaygroundLabels(labels: LabelConfig[], ancestors: string[] = []): Array<{ label: LabelConfig; path: string }> {
  return labels.flatMap(label => {
    const path = [...ancestors, label.name]
    return [{ label, path: path.join(' → ') }, ...flattenPlaygroundLabels(label.children ?? [], path)]
  })
}

function CreateLabelDialogPlaygroundContent() {
  const [labels, setLabels] = React.useState<LabelConfig[]>([
    { id: 'workflow', name: 'Workflow', color: 'accent', children: [{ id: 'auditor', name: 'Auditor', color: 'info' }] },
    { id: 'priority', name: 'Priority', color: 'destructive', valueType: 'number' },
  ])
  const [open, setOpen] = React.useState(false)
  const [parentId, setParentId] = React.useState<string | undefined>()

  const openDialog = (parent?: string) => {
    setParentId(parent)
    setOpen(true)
  }

  const createLabel = async (_workspaceId: string, input: CreateLabelInput): Promise<LabelConfig> => {
    await new Promise(resolve => setTimeout(resolve, 250))
    const baseId = input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'label'
    const existing = new Set(flattenPlaygroundLabels(labels).map(item => item.label.id))
    let id = baseId
    let suffix = 2
    while (existing.has(id)) id = `${baseId}-${suffix++}`
    const created: LabelConfig = { id, name: input.name, color: input.color, valueType: input.valueType }
    setLabels(current => insertPlaygroundLabel(current, input.parentId, created))
    return created
  }

  return (
    <div className="w-[520px] rounded-xl border border-border bg-background p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Manual label creation</h3>
          <p className="text-xs text-muted-foreground">No model call; child context preselects its parent.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => openDialog()}>Create root</Button>
          <Button size="sm" onClick={() => openDialog('workflow')}>Add under Workflow</Button>
        </div>
      </div>
      <div className="space-y-1.5 rounded-lg bg-muted/40 p-3">
        {flattenPlaygroundLabels(labels).map(({ label, path }) => (
          <div key={label.id} className="flex items-center gap-2 text-sm">
            <LabelIcon label={label} size="sm" />
            <span>{path}</span>
            {label.valueType && <span className="text-xs text-muted-foreground">({label.valueType})</span>}
          </div>
        ))}
      </div>
      <CreateLabelDialog
        open={open}
        workspaceId="playground"
        labels={labels}
        defaultParentId={parentId}
        onOpenChange={setOpen}
        createLabel={createLabel}
      />
    </div>
  )
}

function CreateLabelDialogPlayground() {
  return (
    <ModalProvider>
      <CreateLabelDialogPlaygroundContent />
    </ModalProvider>
  )
}

// ============================================================================
// Registry Entry
// ============================================================================

export const labelBadgeComponents: ComponentEntry[] = [
  {
    id: 'label-badge-row-standalone',
    name: 'LabelBadgeRow (Standalone)',
    category: 'Chat Inputs',
    description: 'Standalone label badge row primitive. Note: this is not the stacked ActiveOptionBadges label rendering used by ChatInputZone.',
    component: LabelBadgeRowPlayground,
    props: [
      {
        name: 'showValues',
        description: 'Whether valued labels show their typed values',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'labelCount',
        description: 'Number of labels to display (1-6)',
        control: { type: 'number', min: 1, max: 6, step: 1 },
        defaultValue: 4,
      },
    ],
    variants: [
      {
        name: 'Single boolean label',
        description: 'One label without a value',
        props: { showValues: false, labelCount: 1 },
      },
      {
        name: 'Mixed labels with values',
        description: 'Multiple labels — some boolean, some with number/date/string values',
        props: { showValues: true, labelCount: 4 },
      },
      {
        name: 'Many labels (wrap)',
        description: 'Six labels to demonstrate flex-wrap behavior',
        props: { showValues: true, labelCount: 6 },
      },
      {
        name: 'All boolean',
        description: 'Multiple labels without values',
        props: { showValues: false, labelCount: 4 },
      },
    ],
  },
  {
    id: 'manual-label-creation',
    name: 'Manual Label Creation',
    category: 'Chat Inputs',
    description: 'Deterministic label creation with hierarchical parent selection, color, and value type.',
    component: CreateLabelDialogPlayground,
    props: [],
  },
]
