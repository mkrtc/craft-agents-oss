import { describe, expect, it } from 'bun:test'
import { findDeepLinkArg } from '../deep-link-args'

describe('findDeepLinkArg', () => {
  it('finds the protocol URL in a production Linux/Windows command line', () => {
    expect(findDeepLinkArg([
      '/home/alice/.craft-agent/app/Craft-Agents-x64.AppImage',
      '--no-sandbox',
      'craftagents://auth-complete?code=abc',
    ], 'craftagents')).toBe('craftagents://auth-complete?code=abc')
  })

  it('finds the protocol URL in a development command line', () => {
    expect(findDeepLinkArg([
      '/usr/bin/electron',
      '/repo/apps/electron',
      'craftagents://session/open?id=123',
    ], 'craftagents')).toBe('craftagents://session/open?id=123')
  })

  it('matches URL schemes case-insensitively', () => {
    expect(findDeepLinkArg(['CraftAgents://auth-complete'], 'craftagents')).toBe('CraftAgents://auth-complete')
  })

  it('ignores non-matching arguments', () => {
    expect(findDeepLinkArg([
      'https://agents.craft.do',
      'craftagents-extra://auth-complete',
      '--flag=craftagents://not-a-standalone-arg',
    ], 'craftagents')).toBeUndefined()
  })
})
