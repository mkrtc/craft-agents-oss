import { describe, expect, it } from 'bun:test'
import { getSelectContentLayerClass } from '../select'

describe('getSelectContentLayerClass', () => {
  it('keeps ordinary selects at the dropdown layer', () => {
    expect(getSelectContentLayerClass('default')).toBe('z-dropdown')
  })

  it('raises body-ported dialog selects to the semantic floating-menu layer', () => {
    expect(getSelectContentLayerClass('modal')).toBe('z-floating-menu')
  })
})
