import type { ConceptSet } from '@/types'

/**
 * Resolve a concept set's translatable fields for the given locale.
 * Falls back to the stored default values (which were set at import time).
 */
export function getConceptSetI18n(cs: ConceptSet, lang: string) {
  const code = lang.substring(0, 2)
  const tr = cs.translations?.[code] ?? cs.translations?.en
  return {
    name: tr?.name || cs.name,
    description: tr?.description || cs.description,
    longDescription: tr?.longDescription || undefined,
    category: tr?.category || cs.category,
    subcategory: tr?.subcategory || cs.subcategory,
  }
}
