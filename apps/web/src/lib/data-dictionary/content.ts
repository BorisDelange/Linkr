/**
 * A data dictionary's content, read from a repository with the INDICATE layout:
 * `concept_sets/*.json` (one OHDSI concept set each), `units/unit_conversions.json`,
 * `units/recommended_units.json`, and an optional `config.json` naming it.
 *
 * The sync is keyed on the set's `metadata.uniqueId` (else its file), and updates
 * a set in place — same local id — so the projects using it keep it. Twin of
 * apps/api/app/services/data_dictionary_service.py.
 */
import type { ConceptSet, RecommendedUnit, UnitConversion } from '@/types'
import { parseConceptSetJson } from './parse'

export const CONCEPT_SETS_DIR = 'concept_sets'
export const UNIT_CONVERSIONS_FILE = 'units/unit_conversions.json'
export const RECOMMENDED_UNITS_FILE = 'units/recommended_units.json'

/** A concept set as the repository holds it — no local id. */
export interface IncomingConceptSet {
  name: string
  description: string
  expression: { items: ConceptSet['expression']['items'] }
  sourceUrl: string
  uniqueId?: string
  sourceRepo?: string
  category?: string
  subcategory?: string
  provenance?: string
  version?: string
  translations?: ConceptSet['translations']
}

export interface DictionaryContent {
  conceptSets: IncomingConceptSet[]
  unitConversions: UnitConversion[] | null
  recommendedUnits: RecommendedUnit[] | null
  commit: string | null
  /** `config.json` title, to name a new dictionary. */
  title?: string
}

/** Is `path` part of what a dictionary sync reads? (Everything else in the repo
 *  — the app, resolved snapshots, CI — is left out.) */
export function isDictionaryFile(path: string): boolean {
  const parts = path.split('/')
  return (parts.length === 2 && parts[0] === CONCEPT_SETS_DIR && parts[1].endsWith('.json'))
    || path === UNIT_CONVERSIONS_FILE || path === RECOMMENDED_UNITS_FILE || path === 'config.json'
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

// `2.json` before `10.json`, and never 0 for two paths that differ (a
// localeCompare with `numeric` reads `02` and `2` as equal, leaving the
// duplicate-uniqueId winner to object-key order).
function naturalCompare(a: string, b: string): number {
  const ax = a.split(/(\d+)/)
  const bx = b.split(/(\d+)/)
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const as = ax[i] ?? ''
    const bs = bx[i] ?? ''
    if (as === bs) continue
    if (/^\d+$/.test(as) && /^\d+$/.test(bs) && Number(as) !== Number(bs)) return Number(as) - Number(bs)
    return as < bs ? -1 : 1
  }
  return 0
}

// --- Unit rows -------------------------------------------------------------

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * Unit rows are attacker-suppliable (a dictionary repo, a ZIP, a stored sync)
 * and their numbers are interpolated into the exported extraction SQL: a row
 * whose required numeric fields do not coerce to a finite number is dropped.
 * Twin of `_sanitize_unit_rows` in apps/api/app/services/data_dictionary_service.py.
 */
export function sanitizeUnitConversions(rows: unknown): UnitConversion[] | null {
  if (!Array.isArray(rows)) return null
  const out: UnitConversion[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const conceptId = asFiniteNumber(r.conceptId)
    const sourceUnitConceptId = asFiniteNumber(r.sourceUnitConceptId)
    const targetUnitConceptId = asFiniteNumber(r.targetUnitConceptId)
    const conversionFactor = asFiniteNumber(r.conversionFactor)
    const offset = r.offset === undefined || r.offset === null ? undefined : asFiniteNumber(r.offset)
    if (conceptId === null || sourceUnitConceptId === null || targetUnitConceptId === null
      || conversionFactor === null || offset === null) continue
    out.push({
      conceptId,
      sourceUnitConceptId,
      targetUnitConceptId,
      conversionFactor,
      ...(offset !== undefined ? { offset } : {}),
      conceptName: str(r.conceptName),
      sourceUnitCode: str(r.sourceUnitCode),
      sourceUnitName: str(r.sourceUnitName),
      targetUnitCode: str(r.targetUnitCode),
      targetUnitName: str(r.targetUnitName),
    })
  }
  return out
}

/** Same gate as `sanitizeUnitConversions`, for `units/recommended_units.json`. */
export function sanitizeRecommendedUnits(rows: unknown): RecommendedUnit[] | null {
  if (!Array.isArray(rows)) return null
  const out: RecommendedUnit[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const conceptId = asFiniteNumber(r.conceptId)
    const recommendedUnitConceptId = asFiniteNumber(r.recommendedUnitConceptId)
    if (conceptId === null || recommendedUnitConceptId === null) continue
    out.push({
      conceptId,
      recommendedUnitConceptId,
      conceptName: str(r.conceptName),
      conceptCode: str(r.conceptCode),
      vocabularyId: str(r.vocabularyId),
      domainId: str(r.domainId),
      recommendedUnitName: str(r.recommendedUnitName),
      recommendedUnitCode: str(r.recommendedUnitCode),
      recommendedUnitVocabularyId: str(r.recommendedUnitVocabularyId),
    })
  }
  return out
}

/**
 * A ZIP's entries as a repository tree: paths from the dictionary's root. An
 * archive downloaded from a forge nests everything under one folder
 * (`data-dictionary-main/concept_sets/…`); that folder is dropped. Returns the
 * paths `readDictionaryTree` reads, nothing else.
 */
export function zipPathsToTree(entries: Readonly<Record<string, string>>): Record<string, string> {
  const paths = Object.keys(entries)
  const anchor = paths.find((p) => p === `${CONCEPT_SETS_DIR}/` || p.startsWith(`${CONCEPT_SETS_DIR}/`) || p.includes(`/${CONCEPT_SETS_DIR}/`))
  const root = anchor ? anchor.slice(0, anchor.indexOf(`${CONCEPT_SETS_DIR}/`)) : ''
  const tree: Record<string, string> = {}
  for (const path of paths) {
    if (!path.startsWith(root)) continue
    const rel = path.slice(root.length)
    if (isDictionaryFile(rel)) tree[rel] = entries[path]
  }
  return tree
}

/** Read a repository tree (`{path: text}`, paths from the repo root). */
export function readDictionaryTree(files: Readonly<Record<string, string>>, commit: string | null, lang = 'en'): DictionaryContent {
  const conceptSets: IncomingConceptSet[] = []
  for (const path of Object.keys(files).filter(isDictionaryFile).sort(naturalCompare)) {
    if (!path.startsWith(`${CONCEPT_SETS_DIR}/`)) continue
    const parsed = parseConceptSetJson(parseJson(files[path]), lang)
    if (!parsed) continue
    conceptSets.push({
      name: parsed.name,
      description: parsed.description ?? '',
      expression: { items: parsed.items },
      sourceUrl: path,
      uniqueId: parsed.uniqueId,
      sourceRepo: parsed.sourceRepo,
      category: parsed.category,
      subcategory: parsed.subcategory,
      provenance: parsed.provenance,
      version: parsed.version,
      translations: parsed.translations,
    })
  }
  const conversions = parseJson(files[UNIT_CONVERSIONS_FILE])
  const recommended = parseJson(files[RECOMMENDED_UNITS_FILE])
  const config = parseJson(files['config.json']) as { title?: unknown } | undefined
  return {
    conceptSets,
    unitConversions: sanitizeUnitConversions(conversions),
    recommendedUnits: sanitizeRecommendedUnits(recommended),
    commit,
    ...(typeof config?.title === 'string' ? { title: config.title } : {}),
  }
}

// --- Sync plan -------------------------------------------------------------

/** The fields a sync writes; anything else (local id, resolution) stays. */
export const SYNCED_FIELDS = [
  'name', 'description', 'expression', 'sourceUrl', 'uniqueId', 'sourceRepo',
  'category', 'subcategory', 'provenance', 'version', 'translations',
] as const

export function setKey(set: { uniqueId?: string | null; sourceUrl?: string | null }): string | null {
  return set.uniqueId ? `u:${set.uniqueId}` : set.sourceUrl ? `f:${set.sourceUrl}` : null
}

/** JSON with sorted keys and `undefined` read as `null`: the server returns
 *  nulls where the client leaves fields out, which is not a change. */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k] ?? null]))
    }
    return v ?? null
  })
}

export interface DictionarySyncPlan {
  added: IncomingConceptSet[]
  updated: { id: string; incoming: IncomingConceptSet; fromVersion?: string }[]
  removed: ConceptSet[]
  unchanged: number
}

export function planDictionarySync(existing: readonly ConceptSet[], incoming: readonly IncomingConceptSet[]): DictionarySyncPlan {
  const byKey = new Map<string, ConceptSet>()
  for (const set of existing) {
    const key = setKey(set)
    if (key) byKey.set(key, set)
  }
  const plan: DictionarySyncPlan = { added: [], updated: [], removed: [], unchanged: 0 }
  const seen = new Set<string>()
  for (const next of incoming) {
    const key = setKey(next)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const current = byKey.get(key)
    if (!current) plan.added.push(next)
    else if (SYNCED_FIELDS.some((f) => canonical(current[f]) !== canonical(next[f]))) {
      plan.updated.push({ id: current.id, incoming: next, fromVersion: current.version })
    } else plan.unchanged++
  }
  for (const [key, set] of byKey) if (!seen.has(key)) plan.removed.push(set)
  return plan
}
