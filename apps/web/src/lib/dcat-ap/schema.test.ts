import { describe, expect, it } from 'vitest'
import en from '@/locales/en.json'
import fr from '@/locales/fr.json'
import { DCAT_FIELDS, DCAT_VOCABULARIES } from './schema'

const lookup = (bundle: unknown, key: string) =>
  key.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], bundle)

describe('Health-DCAT-AP schema labels', () => {
  const keys = [
    ...DCAT_FIELDS.flatMap((f) => [f.labelKey, f.descriptionKey]),
    ...Object.values(DCAT_VOCABULARIES).flat().flatMap((o) => (o.labelKey ? [o.labelKey] : [])),
  ]
  it.each([['en', en], ['fr', fr]])('every field and vocabulary option has a %s label', (_, bundle) => {
    expect(keys.filter((k) => typeof lookup(bundle, k) !== 'string')).toEqual([])
  })

  it('field keys are unique', () => {
    expect(new Set(DCAT_FIELDS.map((f) => f.key)).size).toBe(DCAT_FIELDS.length)
  })
})
