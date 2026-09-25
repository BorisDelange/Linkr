import { canonicalRelationSpec } from '@linkr/format'
import type { RelationSpec, SchemaMapping, SchemaOverrides } from '@/types/schema-mapping'
import { specAt, specEntries, withSpec } from './spec'

// ---------------------------------------------------------------------------
// Per-database override (plan §7): a database keeps a copy of its preset's
// mapping as its base, and changes parameter values or whole relations on top.
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

/** The base with the overrides applied: relations replaced or added, parameter
 *  values changed. Parameters the base does not declare are ignored. */
export function effectiveMapping(base: SchemaMapping, overrides: SchemaOverrides | undefined | null): SchemaMapping {
  if (!overrides || (!overrides.relations && !overrides.params)) return base
  let m = base
  for (const [key, spec] of Object.entries(overrides.relations ?? {})) {
    m = specAt(m, key) ? withSpec(m, key, spec) : addSpec(m, key, spec)
  }
  const values = overrides.params ?? {}
  if (base.params && Object.keys(values).length) {
    m = {
      ...m,
      params: Object.fromEntries(
        Object.entries(base.params).map(([name, p]) => [name, name in values ? { ...p, default: values[name] } : p]),
      ),
    }
  }
  return m
}

/**
 * The overrides that turn `base` into `edited`, relation by relation, keeping
 * parameter values as they were. Records, for each newly overridden relation,
 * the base it was made against — how a later preset update is flagged.
 */
export function diffOverrides(base: SchemaMapping, edited: SchemaMapping, previous?: SchemaOverrides | null): SchemaOverrides {
  const relations: Record<string, RelationSpec> = {}
  const baseAtOverride: Record<string, string> = {}
  for (const { specKey, spec } of specEntries(edited)) {
    const baseSpec = specAt(base, specKey)
    if (baseSpec && relationFingerprint(specKey, baseSpec) === relationFingerprint(specKey, spec)) continue
    relations[specKey] = spec
    baseAtOverride[specKey] = previous?.baseAtOverride?.[specKey] ?? relationFingerprint(specKey, baseSpec)
  }
  const out: SchemaOverrides = {}
  if (previous?.params && Object.keys(previous.params).length) out.params = previous.params
  if (Object.keys(relations).length) {
    out.relations = relations
    out.baseAtOverride = baseAtOverride
  }
  return out
}

/** The override without one relation (Revert to preset). */
export function revertOverride(overrides: SchemaOverrides, specKey: string): SchemaOverrides {
  const relations = { ...(overrides.relations ?? {}) }
  const baseAtOverride = { ...(overrides.baseAtOverride ?? {}) }
  delete relations[specKey]
  delete baseAtOverride[specKey]
  const out: SchemaOverrides = {}
  if (overrides.params && Object.keys(overrides.params).length) out.params = overrides.params
  if (Object.keys(relations).length) {
    out.relations = relations
    out.baseAtOverride = baseAtOverride
  }
  return out
}

/** Relation overrides whose base changed since they were made — after a preset
 *  update, the ones worth a look ("the preset changed this relation"). */
export function staleOverrides(base: SchemaMapping, overrides: SchemaOverrides | undefined | null): string[] {
  return Object.keys(overrides?.relations ?? {}).filter(
    (key) => overrides?.baseAtOverride?.[key] !== undefined && overrides.baseAtOverride[key] !== relationFingerprint(key, specAt(base, key)),
  )
}

/** Nothing to store: no relation and no parameter overridden. */
export function isEmptyOverrides(overrides: SchemaOverrides | undefined | null): boolean {
  return !overrides || (!Object.keys(overrides.relations ?? {}).length && !Object.keys(overrides.params ?? {}).length)
}
