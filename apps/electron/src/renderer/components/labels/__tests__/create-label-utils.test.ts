import { describe, expect, test } from 'bun:test'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { buildLabelParentOptions, resolveInitialParentId } from '../create-label-utils'

const labels: LabelConfig[] = [
  {
    id: 'workflow',
    name: 'Workflow',
    children: [
      {
        id: 'auditor',
        name: 'Auditor',
        children: [
          {
            id: 'reports',
            name: 'Reports',
            children: [
              {
                id: 'weekly',
                name: 'Weekly',
                children: [{ id: 'internal', name: 'Internal' }],
              },
            ],
          },
        ],
      },
    ],
  },
  { id: 'priority', name: 'Priority' },
]

describe('manual label parent options', () => {
  test('preserves hierarchy as readable breadcrumbs', () => {
    expect(buildLabelParentOptions(labels).map(option => option.label)).toEqual([
      'Workflow',
      'Workflow → Auditor',
      'Workflow → Auditor → Reports',
      'Workflow → Auditor → Reports → Weekly',
      'Workflow → Auditor → Reports → Weekly → Internal',
      'Priority',
    ])
  })

  test('disables level-five labels because a child would exceed max depth', () => {
    const options = buildLabelParentOptions(labels)
    expect(options.find(option => option.id === 'weekly')?.disabled).toBe(false)
    expect(options.find(option => option.id === 'internal')?.disabled).toBe(true)
  })

  test('accepts an enabled requested parent and rejects missing or max-depth parents', () => {
    const options = buildLabelParentOptions(labels)
    expect(resolveInitialParentId(options, 'workflow')).toBe('workflow')
    expect(resolveInitialParentId(options, 'internal')).toBeUndefined()
    expect(resolveInitialParentId(options, 'missing')).toBeUndefined()
  })
})
