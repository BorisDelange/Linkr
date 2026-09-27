import { describe, expect, it } from 'vitest'
import en from '@/locales/en.json'
import fr from '@/locales/fr.json'
import { DCAT_FIELDS, DCAT_VOCABULARIES } from './schema'

// Typed unknown: the JSON's literal types are huge and slow the compiler to a crawl.
const BUNDLES: Record<string, unknown> = { en, fr }
const lookup = (bundle: unknown, key: string) => {
  let node: unknown = bundle
  for (const k of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[k]
  return node
}

describe('Health-DCAT-AP schema labels', () => {
  const keys = [
    ...DCAT_FIELDS.flatMap((f) => [f.labelKey, f.descriptionKey]),
    ...Object.values(DCAT_VOCABULARIES).flat().flatMap((o) => (o.labelKey ? [o.labelKey] : [])),
  ]
  it.each(['en', 'fr'])('every field and vocabulary option has a %s label', (lang) => {
    expect(keys.filter((k) => typeof lookup(BUNDLES[lang], k) !== 'string')).toEqual([])
  })

  it('field keys are unique', () => {
    expect(new Set(DCAT_FIELDS.map((f) => f.key)).size).toBe(DCAT_FIELDS.length)
  })
})
