import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useShortcutStore } from './shortcut-store'
import { DEFAULT_SHORTCUTS } from '@/types/shortcuts'

// Tests run in a Node environment by design (docs/conventions.md), so stub the
// bit of Web Storage this module uses rather than pulling in jsdom.
beforeAll(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
})

beforeEach(() => {
  useShortcutStore.getState().resetAll()
})

const DEFAULT_TOGGLE_SIDEBAR = DEFAULT_SHORTCUTS.toggle_sidebar.defaultBinding

describe('setBinding', () => {
  it('records a binding that differs from the default', () => {
    const { setBinding } = useShortcutStore.getState()
    setBinding('toggle_sidebar', { key: 'j', ctrlOrMeta: true, shift: false, alt: false })

    const state = useShortcutStore.getState()
    expect(state.getBinding('toggle_sidebar').key).toBe('j')
    expect(state.isCustomized('toggle_sidebar')).toBe(true)
  })

  it('treats rebinding to the default value as a reset', () => {
    const { setBinding } = useShortcutStore.getState()
    setBinding('toggle_sidebar', { key: 'j', ctrlOrMeta: true, shift: false, alt: false })
    expect(useShortcutStore.getState().isCustomized('toggle_sidebar')).toBe(true)

    setBinding('toggle_sidebar', { ...DEFAULT_TOGGLE_SIDEBAR })

    const state = useShortcutStore.getState()
    expect(state.isCustomized('toggle_sidebar')).toBe(false)
    expect(state.customBindings.toggle_sidebar).toBeUndefined()
  })

  it('ignores case when comparing against the default', () => {
    const { setBinding } = useShortcutStore.getState()
    setBinding('toggle_sidebar', {
      ...DEFAULT_TOGGLE_SIDEBAR,
      key: DEFAULT_TOGGLE_SIDEBAR.key.toUpperCase(),
    })

    expect(useShortcutStore.getState().isCustomized('toggle_sidebar')).toBe(false)
  })
})

describe('isCustomized', () => {
  it('is false for an untouched action', () => {
    expect(useShortcutStore.getState().isCustomized('toggle_sidebar')).toBe(false)
  })

  it('compares values, so a persisted entry equal to the default does not count', () => {
    // Settings saved before setBinding filtered these out, or written by a preset.
    useShortcutStore.setState({
      customBindings: { toggle_sidebar: { ...DEFAULT_TOGGLE_SIDEBAR } },
    })

    expect(useShortcutStore.getState().isCustomized('toggle_sidebar')).toBe(false)
  })
})

describe('resetBinding', () => {
  it('restores the default and clears the customized flag', () => {
    const { setBinding } = useShortcutStore.getState()
    setBinding('toggle_sidebar', { key: 'j', ctrlOrMeta: true, shift: false, alt: false })

    useShortcutStore.getState().resetBinding('toggle_sidebar')

    const state = useShortcutStore.getState()
    expect(state.getBinding('toggle_sidebar')).toEqual(DEFAULT_TOGGLE_SIDEBAR)
    expect(state.isCustomized('toggle_sidebar')).toBe(false)
  })
})
