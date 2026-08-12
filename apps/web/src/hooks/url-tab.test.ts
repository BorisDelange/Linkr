import { describe, it, expect } from 'vitest'
import { resolveTab, restorableTab } from './url-tab'

const TABS = ['progress', 'concept-sets', 'editor', 'versioning'] as const
type Tab = (typeof TABS)[number]

const resolve = (options: {
  fromUrl: string | null
  restored?: Tab | null
  restorePending?: boolean
}) =>
  resolveTab<Tab>({
    fromUrl: options.fromUrl,
    tabs: TABS,
    defaultTab: 'progress',
    restored: options.restored ?? null,
    restorePending: options.restorePending ?? false,
  })

describe('restorableTab', () => {
  it('restores a remembered non-default tab', () => {
    expect(restorableTab('versioning', TABS, 'progress')).toBe('versioning')
  })

  it('has nothing to restore without a memory', () => {
    expect(restorableTab(undefined, TABS, 'progress')).toBeNull()
  })

  it('does not restore the default tab, which writes no param', () => {
    expect(restorableTab('progress', TABS, 'progress')).toBeNull()
  })

  it('ignores a tab that no longer exists', () => {
    expect(restorableTab('retired-tab', TABS, 'progress')).toBeNull()
  })
})

describe('resolveTab', () => {
  it('follows an explicit ?tab=', () => {
    expect(resolve({ fromUrl: 'editor' })).toEqual({ activeTab: 'editor' })
  })

  it('lets an explicit ?tab= win over the remembered tab', () => {
    const result = resolve({ fromUrl: 'editor', restored: 'versioning', restorePending: true })
    expect(result).toEqual({ activeTab: 'editor' })
  })

  it('falls back to the default on an unknown ?tab= instead of rendering nothing', () => {
    expect(resolve({ fromUrl: 'bogus' })).toEqual({ activeTab: 'progress' })
  })

  it('reopens the remembered tab on arrival', () => {
    const result = resolve({ fromUrl: null, restored: 'versioning', restorePending: true })
    expect(result).toEqual({ activeTab: 'versioning' })
  })

  it('opens the default tab on arrival with nothing remembered', () => {
    expect(resolve({ fromUrl: null })).toEqual({ activeTab: 'progress' })
  })

  // The regression: selecting the default tab clears the param, which must not
  // be read as a fresh arrival — otherwise the remembered tab is restored right
  // back and the default tab becomes unselectable.
  it('stays on the default tab once the restore has been consumed', () => {
    const result = resolve({ fromUrl: null, restored: 'versioning', restorePending: false })
    expect(result).toEqual({ activeTab: 'progress' })
  })
})
