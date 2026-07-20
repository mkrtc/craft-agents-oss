import type { LabelConfig } from '@craft-agent/shared/labels'

export const MAX_LABEL_DEPTH = 5

export interface LabelParentOption {
  id: string
  label: string
  depth: number
  disabled: boolean
}

/** Flatten a label tree into parent choices while preserving the full breadcrumb. */
export function buildLabelParentOptions(
  labels: readonly LabelConfig[],
  ancestors: readonly string[] = [],
  depth = 1,
): LabelParentOption[] {
  const options: LabelParentOption[] = []

  for (const label of labels) {
    const path = [...ancestors, label.name]
    options.push({
      id: label.id,
      label: path.join(' → '),
      depth,
      disabled: depth >= MAX_LABEL_DEPTH,
    })

    if (label.children?.length) {
      options.push(...buildLabelParentOptions(label.children, path, depth + 1))
    }
  }

  return options
}

export function resolveInitialParentId(
  options: readonly LabelParentOption[],
  requestedParentId?: string,
): string | undefined {
  if (!requestedParentId) return undefined
  const option = options.find(candidate => candidate.id === requestedParentId)
  return option && !option.disabled ? option.id : undefined
}
