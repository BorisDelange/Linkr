import { describe, it, expect } from 'vitest'
import { hasPluginReadme } from './plugin-readme'
import type { Plugin } from '@/types/plugin'

function plugin(readme?: Plugin['readme']): Plugin {
  return {
    manifest: {
      id: 'p',
      name: { en: 'P', fr: 'P' },
      description: { en: '', fr: '' },
      version: '1.0.0',
      tags: [],
      runtime: ['component'],
      languages: [],
      icon: 'Puzzle',
      configSchema: {},
    },
    templates: null,
    readme,
  }
}

describe('hasPluginReadme', () => {
  it('is false when the plugin carries no readme at all', () => {
    expect(hasPluginReadme(plugin())).toBe(false)
    expect(hasPluginReadme(undefined)).toBe(false)
    expect(hasPluginReadme(null)).toBe(false)
  })

  it('is true as soon as one language has content', () => {
    expect(hasPluginReadme(plugin({ en: '# Docs' }))).toBe(true)
    // A French-only readme still counts: the renderer falls back across languages.
    expect(hasPluginReadme(plugin({ fr: '# Doc' }))).toBe(true)
  })

  // Old rows stored an explicit empty string for the untouched language, so a
  // blank value must not light up the Doc tab on an otherwise undocumented plugin.
  it('ignores blank and whitespace-only languages', () => {
    expect(hasPluginReadme(plugin({ en: '', fr: '' }))).toBe(false)
    expect(hasPluginReadme(plugin({ en: '   \n  ' }))).toBe(false)
    expect(hasPluginReadme(plugin({ en: '', fr: '# Doc' }))).toBe(true)
  })
})
