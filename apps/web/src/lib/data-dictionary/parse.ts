/**
 * Reading a concept-set JSON (OHDSI/ATLAS `{name, expression: {items}}`, with the
 * INDICATE `metadata` block: translations, uniqueId, version, organization).
 */
import type { ConceptSetItem, ConceptSetTranslation } from '@/types'

export interface ParsedConceptSet {
  name: string
  description?: string
  items: ConceptSetItem[]
  category?: string
  subcategory?: string
  provenance?: string
  version?: string
  /** Stable cross-install id from `metadata.uniqueId`. */
  uniqueId?: string
  /** Origin dictionary repo from `metadata.sourceRepo`. */
  sourceRepo?: string
  /** All translations from the source JSON, keyed by lang code. */
  translations?: Record<string, { name?: string; description?: string; category?: string; subcategory?: string }>
}

/** Extract raw translations map from INDICATE-style JSON metadata. */
export function extractTranslations(obj: Record<string, unknown>): Record<string, ConceptSetTranslation> | undefined {
  const meta = obj.metadata as Record<string, unknown> | undefined
  if (!meta) return undefined
  const translations = meta.translations as Record<string, Record<string, string>> | undefined
  if (!translations || Object.keys(translations).length === 0) return undefined
  const result: Record<string, ConceptSetTranslation> = {}
  for (const [lang, tr] of Object.entries(translations)) {
    result[lang] = {
      name: tr.name || undefined,
      description: tr.description || undefined,
      longDescription: tr.longDescription || undefined,
      category: tr.category || undefined,
      subcategory: tr.subcategory || undefined,
    }
  }
  return result
}

/** Extract metadata (category, subcategory, provenance, version, uniqueId, sourceRepo) from INDICATE-style JSON. */
export function extractMetadata(obj: Record<string, unknown>, lang: string): { category?: string; subcategory?: string; provenance?: string; version?: string; uniqueId?: string; sourceRepo?: string } {
  const meta = obj.metadata as Record<string, unknown> | undefined
  if (!meta) return {}

  const translations = meta.translations as Record<string, Record<string, string>> | undefined
  const tr = translations?.[lang] ?? translations?.en ?? {}

  // organization is { created: { name, url }, current: { name, url } } — prefer
  // the current owner, fall back to the creator, then to a flat `name` for
  // older/other formats.
  const org = meta.organization as Record<string, unknown> | undefined
  const orgName =
    (org?.current as Record<string, unknown> | undefined)?.name ??
    (org?.created as Record<string, unknown> | undefined)?.name ??
    org?.name

  return {
    category: tr.category || undefined,
    subcategory: tr.subcategory || undefined,
    provenance: orgName ? String(orgName) : undefined,
    version: meta.version ? String(meta.version) : (obj.version ? String(obj.version) : undefined),
    uniqueId: meta.uniqueId ? String(meta.uniqueId) : undefined,
    sourceRepo: meta.sourceRepo ? String(meta.sourceRepo) : undefined,
  }
}

/** Validate an OHDSI concept set JSON structure. */
export function parseConceptSetJson(json: unknown, lang = 'en'): ParsedConceptSet | null {
  if (!json || typeof json !== 'object') return null
  const obj = json as Record<string, unknown>

  let base: { name: string; description?: string; items: ConceptSetItem[] } | null = null

  // Support OHDSI format: { name, expression: { items: [...] } }
  if (obj.expression && typeof obj.expression === 'object') {
    const expr = obj.expression as Record<string, unknown>
    if (Array.isArray(expr.items)) {
      // Use translated name if available
      const meta = obj.metadata as Record<string, unknown> | undefined
      const translations = meta?.translations as Record<string, Record<string, string>> | undefined
      const tr = translations?.[lang] ?? translations?.en

      base = {
        name: tr?.name ?? String(obj.name ?? 'Unnamed Concept Set'),
        description: tr?.description ?? (obj.description ? String(obj.description) : undefined),
        items: expr.items as ConceptSetItem[],
      }
    }
  }

  // Support direct items array: { name, items: [...] }
  if (!base && Array.isArray(obj.items)) {
    base = {
      name: String(obj.name ?? 'Unnamed Concept Set'),
      description: obj.description ? String(obj.description) : undefined,
      items: obj.items as ConceptSetItem[],
    }
  }

  if (!base) return null

  const metadata = extractMetadata(obj, lang)
  const translations = extractTranslations(obj)
  return { ...base, ...metadata, translations }
}
