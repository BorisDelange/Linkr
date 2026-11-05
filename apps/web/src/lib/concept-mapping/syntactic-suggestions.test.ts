import { describe, expect, it } from 'vitest'
import en from '@/locales/en.json'
import fr from '@/locales/fr.json'
import { ALL_PROVIDERS, DEFAULT_WEIGHTS, METHOD_DOT_COLORS, getProviderForMethod, providerLabel } from './syntactic-suggestions'

const translator = (locale: typeof en) => (key: string) =>
  key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], locale) as string

describe('getProviderForMethod', () => {
  it.each([
    ['syntactic/jaro-winkler', 'syntactic'],
    ['syntactic/ngram-idf', 'syntactic'],
    ['semantic/biolord', 'semantic'],
    ['statistical/distribution', 'statistical'],
    ['ai/claude-opus', 'agentic'],
  ])('%s → %s', (method, provider) => {
    expect(getProviderForMethod(method)).toBe(provider)
  })

  it('keeps an unknown method as its own family', () => {
    expect(getProviderForMethod('custom/thing')).toBe('custom/thing')
  })
})

describe('providerLabel', () => {
  it('names every family in both languages', () => {
    expect(ALL_PROVIDERS.map((p) => providerLabel(p, translator(en))))
      .toEqual(['Syntactic', 'Semantic', 'Statistical', 'Agentic'])
    expect(ALL_PROVIDERS.map((p) => providerLabel(p, translator(fr))))
      .toEqual(['Syntaxique', 'Sémantique', 'Statistique', 'Agentique'])
  })

  it('shows an unknown family as is', () => {
    expect(providerLabel('custom/thing', translator(en))).toBe('custom/thing')
  })

  it('has a weight and a colour for every family', () => {
    for (const p of ALL_PROVIDERS) {
      expect(DEFAULT_WEIGHTS[p]).toBeGreaterThan(0)
      expect(METHOD_DOT_COLORS[p]).toBeTruthy()
    }
  })
})
