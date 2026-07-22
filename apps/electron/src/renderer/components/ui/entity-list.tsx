/**
 * EntityList — Reusable container for rendering a scrollable list of EntityRow items.
 *
 * Handles:
 * - ScrollArea wrapping with proper padding
 * - Optional grouped layout with section headers
 * - Collapsible groups with chevron toggle and item count
 * - Empty state rendering (centered, outside ScrollArea)
 * - Header (e.g. search bar) and footer (e.g. infinite scroll sentinel) slots
 *
 * Domain-specific logic (filtering, keyboard nav, multi-select) lives in the consumer.
 */

import * as React from 'react'
import { ChevronRight, GripVertical } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
  StyledContextMenuSeparator,
} from '@/components/ui/styled-context-menu'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

export interface EntityListGroup<T> {
  /** Unique key for the group */
  key: string
  /** Label shown in the section header */
  label: string
  /** Items in this group (empty array for collapsed groups — items are excluded from the data pipeline) */
  items: T[]
  /** Whether this group supports collapse/expand (default: false) */
  collapsible?: boolean
  /** Number of hidden items when collapsed. Present on collapsed placeholder groups (items will be []). */
  collapsedCount?: number
  /** Optional accent color used by rich group headers (e.g. custom chat groups). */
  accentColor?: string
  /** Whether the group should render a dedicated reorder drag handle. */
  sortable?: boolean
}

export interface EntityListProps<T> {
  /** Flat item list (used when not grouped) */
  items?: T[]
  /** Grouped items with section headers (takes precedence over items) */
  groups?: EntityListGroup<T>[]
  /** Render function for each item */
  renderItem: (item: T, index: number, isFirstInGroup: boolean) => React.ReactNode
  /** Unique key extractor */
  getKey: (item: T) => string
  /** Empty state content — rendered centered, outside ScrollArea */
  emptyState?: React.ReactNode
  /** Header content above the list (e.g. search bar) — rendered outside ScrollArea */
  header?: React.ReactNode
  /** Footer content after all items (e.g. infinite scroll sentinel) — inside ScrollArea */
  footer?: React.ReactNode
  /** Ref for the inner list container (for keyboard navigation zones) */
  containerRef?: React.Ref<HTMLDivElement>
  /** Props spread on the inner list container (role, aria-label, data-focus-zone) */
  containerProps?: Record<string, string>
  /** Ref to the ScrollArea viewport element (for scroll-based pagination) */
  viewportRef?: React.RefObject<HTMLDivElement>
  /** Additional ScrollArea class */
  scrollAreaClassName?: string
  className?: string
  /** Set of collapsed group keys (for collapsible groups) */
  collapsedGroups?: Set<string>
  /** Called when a collapsible group header is clicked */
  onToggleCollapse?: (groupKey: string) => void
  /** Collapse all collapsible groups */
  onCollapseAll?: () => void
  /** Expand all collapsible groups */
  onExpandAll?: () => void
  /** Reorder drag handle props for a sortable group header. */
  getGroupDragHandleProps?: (group: EntityListGroup<T>) => React.HTMLAttributes<HTMLSpanElement>
  /** Drag/drop target props for a sortable group container. */
  getGroupDropProps?: (group: EntityListGroup<T>) => React.HTMLAttributes<HTMLDivElement>
}

// ============================================================================
// Section Header
// ============================================================================

function GroupDragHandle<T>({ group, getGroupDragHandleProps }: { group: EntityListGroup<T>; getGroupDragHandleProps?: (group: EntityListGroup<T>) => React.HTMLAttributes<HTMLSpanElement> }) {
  if (!group.sortable || !getGroupDragHandleProps) return null
  const props = getGroupDragHandleProps(group)
  return (
    <span
      {...props}
      className={cn(
        "relative p-0.5 rounded-[5px] cursor-grab active:cursor-grabbing text-muted-foreground/45 hover:text-foreground/70 hover:bg-foreground/7",
        props.className,
      )}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        props.onClick?.(e)
      }}
      onMouseDown={(e) => {
        e.stopPropagation()
        props.onMouseDown?.(e)
      }}
    >
      <GripVertical className="h-3 w-3" />
    </span>
  )
}

function SectionHeader<T>({ group, getGroupDragHandleProps }: { group: EntityListGroup<T>; getGroupDragHandleProps?: (group: EntityListGroup<T>) => React.HTMLAttributes<HTMLDivElement> }) {
  const { label, accentColor } = group
  return (
    <div className={cn("flex items-center gap-1.5", accentColor ? "px-3 py-2" : "px-4 py-2")}>
      <GroupDragHandle group={group} getGroupDragHandleProps={getGroupDragHandleProps} />
      <span
        className={cn(
          "text-[11px] uppercase tracking-wider inline-flex items-center gap-1.5",
          accentColor ? "font-semibold" : "font-medium text-muted-foreground"
        )}
        style={accentColor ? { color: `color-mix(in srgb, ${accentColor} 78%, var(--foreground))` } : undefined}
      >
        {accentColor && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accentColor }} />}
        {label}
      </span>
    </div>
  )
}

/** Collapsible group header with chevron toggle and item count when collapsed */
function CollapsibleGroupHeader({
  label,
  isCollapsed,
  itemCount,
  onToggle,
  onCollapseAll,
  onExpandAll,
  accentColor,
  dragHandle,
}: {
  label: string
  isCollapsed: boolean
  itemCount: number
  onToggle: () => void
  onCollapseAll?: () => void
  onExpandAll?: () => void
  accentColor?: string
  dragHandle?: React.ReactNode
}) {
  return (
    <ContextMenu modal>
      <ContextMenuTrigger asChild>
        <button
          onClick={onToggle}
          className={cn(
            "w-full flex items-center gap-1.5 cursor-pointer group/header relative",
            accentColor ? "py-2 px-3" : "py-2 px-4"
          )}
        >
          <div className="absolute inset-y-0.5 left-2 right-2 rounded-[6px] group-hover/header:bg-foreground/2 transition-colors pointer-events-none" />
          {dragHandle}
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground/60 transition-transform relative",
              !isCollapsed && "rotate-90"
            )}
          />
          <span
            className={cn(
              "text-[11px] uppercase tracking-wider relative inline-flex items-center gap-1.5",
              accentColor ? "font-semibold" : "font-medium text-muted-foreground"
            )}
            style={accentColor ? { color: `color-mix(in srgb, ${accentColor} 78%, var(--foreground))` } : undefined}
          >
            {accentColor && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accentColor }} />}
            <span>{label}{isCollapsed && <> · <span className="text-muted-foreground/50">{itemCount}</span></>}</span>
          </span>
        </button>
      </ContextMenuTrigger>
      <StyledContextMenuContent>
        <StyledContextMenuItem onClick={onToggle}>
          {isCollapsed ? 'Expand' : 'Collapse'}
        </StyledContextMenuItem>
        <StyledContextMenuSeparator />
        <StyledContextMenuItem onClick={onCollapseAll}>
          Collapse All
        </StyledContextMenuItem>
        <StyledContextMenuItem onClick={onExpandAll}>
          Expand All
        </StyledContextMenuItem>
      </StyledContextMenuContent>
    </ContextMenu>
  )
}

// ============================================================================
// Component
// ============================================================================

export function EntityList<T>({
  items,
  groups,
  renderItem,
  getKey,
  emptyState,
  header,
  footer,
  containerRef,
  containerProps,
  viewportRef,
  scrollAreaClassName,
  className,
  collapsedGroups,
  onToggleCollapse,
  onCollapseAll,
  onExpandAll,
  getGroupDragHandleProps,
  getGroupDropProps,
}: EntityListProps<T>) {
  // Determine if we have content
  const hasGroups = groups && groups.length > 0
  const hasItems = items && items.length > 0
  const isEmpty = !hasGroups && !hasItems

  // Empty state — rendered outside everything for proper centering
  if (isEmpty && emptyState) {
    return (
      <div className={cn('flex flex-col flex-1', className)}>
        {header}
        {emptyState}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      {header}
      <ScrollArea className={cn('flex-1', scrollAreaClassName)} viewportRef={viewportRef}>
        <div
          ref={containerRef}
          className="flex flex-col pb-2"
          {...containerProps}
        >
          <div className="pt-1">
            {hasGroups
              ? groups!.map((group) => {
                  const isCollapsed = group.collapsible && collapsedGroups?.has(group.key)

                  const hasAccent = !!group.accentColor

                  return (
                    <div
                      key={group.key}
                      className={cn(
                        "relative",
                        hasAccent && "mx-2 my-1 overflow-hidden rounded-[10px] border"
                      )}
                      style={hasAccent ? {
                        backgroundColor: `color-mix(in srgb, ${group.accentColor} 7%, transparent)`,
                        borderColor: `color-mix(in srgb, ${group.accentColor} 16%, transparent)`,
                      } : undefined}
                      {...getGroupDropProps?.(group)}
                    >
                      {hasAccent && (
                        <span
                          className="absolute left-0 top-0 bottom-0 w-0.5 rounded-full"
                          style={{ backgroundColor: group.accentColor }}
                        />
                      )}
                      {group.collapsible && onToggleCollapse ? (
                        <CollapsibleGroupHeader
                          label={group.label}
                          isCollapsed={!!isCollapsed}
                          itemCount={isCollapsed ? (group.collapsedCount ?? 0) : group.items.length}
                          accentColor={group.accentColor}
                          dragHandle={<GroupDragHandle group={group} getGroupDragHandleProps={getGroupDragHandleProps} />}
                          onToggle={() => onToggleCollapse(group.key)}
                          onCollapseAll={onCollapseAll}
                          onExpandAll={onExpandAll}
                        />
                      ) : (
                        <SectionHeader group={group} getGroupDragHandleProps={getGroupDragHandleProps} />
                      )}
                      {group.items.map((item, indexInGroup) =>
                        <React.Fragment key={getKey(item)}>
                          {renderItem(item, indexInGroup, indexInGroup === 0)}
                        </React.Fragment>
                      )}
                    </div>
                  )
                })
              : items?.map((item, index) =>
                  <React.Fragment key={getKey(item)}>
                    {renderItem(item, index, index === 0)}
                  </React.Fragment>
                )
            }
          </div>
          {footer}
        </div>
      </ScrollArea>
    </div>
  )
}
