import { canonicalRelationSpec } from '@linkr/format'
import type { ConceptSpec, EventSpec, RelationSpec, SchemaMapping, SchemaOverrides } from '@/types/schema-mapping'
import { specAt, specEntries, withSpec } from './spec'

// ---------------------------------------------------------------------------
// Per-database override (plan §7): a database keeps a copy of its preset's
// mapping as its base, and replaces or adds whole relations on top.
// Every query reads `effectiveMapping(base, overrides)`; nothing else knows the
// difference.
// ---------------------------------------------------------------------------

/**
 * A short, order-independent fingerprint of a base relation (FNV-1a over its
 * canonical JSON): what an override records of the base it was made against,
 * to flag it once the preset changes that relation. `none` for a relation the
 * base does not have.
 */
export function relationFingerprint(specKey: string, spec: RelationSpec | undefined): string {
  if (!spec) return 'none'
  const text = JSON.stringify(canonicalRelationSpec(specKey, spec))
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Add a relation the base does not have (a site-specific event table). */
function addSpec(mapping: SchemaMapping, specKey: string, spec: RelationSpec): SchemaMapping {
  const [list] = specKey.split('.')
  if (list === 'concepts' || list === 'events' || list === 'drugs') {
    return { ...mapping, [list]: [...((mapping[list] as RelationSpec[] | undefined) ?? []), spec] }
  }
  return withSpec(mapping, specKey, spec)
}

/** The base with the overrides applied: relations replaced or added. */
export function effectiveMapping(base: SchemaMapping, overrides: SchemaOverrides | undefined | null): SchemaMapping {
  if (!overrides?.relations) return base
  let m = base
  for (const [key, spec] of Object.entries(overrides.relations)) {
    m = specAt(m, key) ? withSpec(m, key, spec) : addSpec(m, key, spec)
  }
  return m
}

const LISTS = ['concepts', 'events', 'drugs'] as const

const listId = (list: (typeof LISTS)[number], spec: RelationSpec): string | undefined =>
  list === 'concepts' ? (spec as ConceptSpec).key : (spec as EventSpec).label

/**
 * The key a relation shows under once applied. An override keeps the key of
 * the base relation it replaces, so a renamed event (`events.Old` whose label
 * is now `New`) shows as `events.New`.
 */
export function appliedSpecKey(key: string, spec: RelationSpec): string {
  const [list] = key.split('.')
  const id = (LISTS as readonly string[]).includes(list) ? listId(list as (typeof LISTS)[number], spec) : undefined
  return id ? `${list}.${id}` : key
}

/** The override behind a relation as the effective mapping shows it: its own
 *  key, unless it renamed a base relation. */
export function overrideKeyFor(overrides: SchemaOverrides | undefined | null, shownKey: string): string {
  const entry = Object.entries(overrides?.relations ?? {}).find(([key, spec]) => appliedSpecKey(key, spec) === shownKey)
  return entry?.[0] ?? shownKey
}

/**
 * Base relations `edited` renamed, `shown key → base key`. Lists keep their
 * order (an override replaces in place, an added relation goes last), so a
 * base relation whose name is gone is paired with what now sits at its place.
 */
function renamedBaseKeys(base: SchemaMapping, edited: SchemaMapping): Map<string, string> {
  const out = new Map<string, string>()
  for (const list of LISTS) {
    const baseItems = (base[list] ?? []) as RelationSpec[]
    const editedItems = (edited[list] ?? []) as RelationSpec[]
    const baseIds = new Set(baseItems.map((s) => listId(list, s)))
    const editedIds = new Set(editedItems.map((s) => listId(list, s)))
    baseItems.forEach((b, i) => {
      const from = listId(list, b)
      const to = editedItems[i] && listId(list, editedItems[i])
      if (from && to && !editedIds.has(from) && !baseIds.has(to)) out.set(`${list}.${to}`, `${list}.${from}`)
    })
  }
  return out
}

/**
 * The overrides that turn `base` into `edited`, relation by relation. Records,
 * for each newly overridden relation, the base it was made against — how a
 * later preset update is flagged. A renamed base relation is overridden under
 * its base key, so it replaces that relation rather than adding a second one.
 */
export function diffOverrides(base: SchemaMapping, edited: SchemaMapping, previous?: SchemaOverrides | null): SchemaOverrides {
  const relations: Record<string, RelationSpec> = {}
  const baseAtOverride: Record<string, string> = {}
  const renamed = renamedBaseKeys(base, edited)
  for (const { specKey: shownKey, spec } of specEntries(edited)) {
    const specKey = renamed.get(shownKey) ?? shownKey
    const baseSpec = specAt(base, specKey)
    if (baseSpec && relationFingerprint(specKey, baseSpec) === relationFingerprint(specKey, spec)) continue
    relations[specKey] = spec
    baseAtOverride[specKey] = previous?.baseAtOverride?.[specKey] ?? relationFingerprint(specKey, baseSpec)
  }
  return Object.keys(relations).length ? { relations, baseAtOverride } : {}
}

/** The override without one relation (Revert to preset). */
export function revertOverride(overrides: SchemaOverrides, specKey: string): SchemaOverrides {
  const relations = { ...(overrides.relations ?? {}) }
  const baseAtOverride = { ...(overrides.baseAtOverride ?? {}) }
  delete relations[specKey]
  delete baseAtOverride[specKey]
  return Object.keys(relations).length ? { relations, baseAtOverride } : {}
}

/** Relation overrides whose base changed since they were made — after a preset
 *  update, the ones worth a look ("the preset changed this relation"). */
export function staleOverrides(base: SchemaMapping, overrides: SchemaOverrides | undefined | null): string[] {
  return Object.keys(overrides?.relations ?? {}).filter(
    (key) => overrides?.baseAtOverride?.[key] !== undefined && overrides.baseAtOverride[key] !== relationFingerprint(key, specAt(base, key)),
  )
}

/** Nothing to store: no relation overridden. */
export function isEmptyOverrides(overrides: SchemaOverrides | undefined | null): boolean {
  return !Object.keys(overrides?.relations ?? {}).length
}
