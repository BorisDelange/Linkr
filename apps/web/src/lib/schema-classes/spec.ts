import type { ConceptSpec, FieldSpec, RelationSpec, RelationTable, SchemaMapping } from '@/types/schema-mapping'
import type { ClassName } from './contracts'

/** Every relation spec of a mapping, with where it lives (`visit`,
 *  `events.<label>`…) — the key a database override uses too. */
export interface SpecEntry {
  specKey: string
  cls: ClassName
  spec: RelationSpec
  /** Concept key or event / drug label. */
  key?: string
}

export function specEntries(mapping: SchemaMapping): SpecEntry[] {
  const out: SpecEntry[] = []
  if (mapping.patient) out.push({ specKey: 'patient', cls: 'patient', spec: mapping.patient })
  if (mapping.visit) out.push({ specKey: 'visit', cls: 'visit', spec: mapping.visit })
  if (mapping.visitDetail) out.push({ specKey: 'visitDetail', cls: 'visit_detail', spec: mapping.visitDetail })
  if (mapping.note) out.push({ specKey: 'note', cls: 'note', spec: mapping.note })
  for (const c of mapping.concepts ?? []) out.push({ specKey: `concepts.${c.key}`, cls: 'concept', spec: c, key: c.key })
  for (const e of mapping.events ?? []) out.push({ specKey: `events.${e.label}`, cls: 'event', spec: e, key: e.label })
  for (const d of mapping.drugs ?? []) out.push({ specKey: `drugs.${d.label}`, cls: 'drug', spec: d, key: d.label })
  return out
}

/** The relation spec stored under `specKey`, if any. */
export function specAt(mapping: SchemaMapping, specKey: string): RelationSpec | undefined {
  return specEntries(mapping).find((e) => e.specKey === specKey)?.spec
}

/** The tables a visual relation reads (`from` first, then its joins). Empty for
 *  a relation defined in SQL, whose tables are not known without parsing it. */
export function specTables(spec: RelationSpec | undefined): RelationTable[] {
  if (!spec || spec.customSql?.trim()) return []
  return [spec.from, ...(spec.joins ?? [])].filter((t): t is RelationTable => !!t)
}

/**
 * The grain table of a visual relation with no filter: counting its rows counts
 * the relation's rows, without going through the relation. Undefined for SQL,
 * or when a WHERE or an inner join changes the row count.
 */
export function grainTable(spec: RelationSpec | undefined): RelationTable | undefined {
  if (!spec || spec.customSql?.trim() || spec.where?.trim()) return undefined
  if (spec.joins?.some((j) => j.type === 'inner')) return undefined
  return spec.from
}

/** Every table a mapping's visual relations read, deduplicated. */
export function mappingTables(mapping: SchemaMapping): RelationTable[] {
  const seen = new Map<string, RelationTable>()
  for (const { spec } of specEntries(mapping)) {
    for (const t of specTables(spec)) {
      const k = `${t.schema ?? ''}.${t.table}`.toLowerCase()
      if (!seen.has(k)) seen.set(k, t)
    }
  }
  return [...seen.values()]
}

/** The `alias.column` a field names, split — or null for an expression or a constant. */
export function fieldRef(field: FieldSpec | undefined): { alias: string; column: string } | null {
  if (typeof field !== 'string') return null
  const m = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(field.trim())
  return m ? { alias: m[1], column: m[2] } : null
}

/** The source table and column a field reads directly, when it is a plain reference. */
export function fieldColumn(spec: RelationSpec | undefined, field: string): { table: RelationTable; column: string } | null {
  const r = fieldRef(spec?.fields?.[field])
  if (!r || !spec) return null
  const table = specTables(spec).find((t) => t.alias.toLowerCase() === r.alias.toLowerCase())
  return table ? { table, column: r.column } : null
}

/**
 * What makes a source concept's identity in a concept-mapping project. Mapping
 * projects store these ids, so the rule must not change:
 *  - `ownId`: the dictionary has an id of its own. Without one (a code-only table
 *    like MIMIC d_icd_diagnoses, where `concept_id` reads the code itself) the id
 *    is a deterministic integer hash of the code, or of the name.
 *  - `table`: the vocabulary a concept falls back to when no terminology is mapped.
 */
export interface ConceptIdentity {
  key: string
  ownId: boolean
  hasCode: boolean
  table: string
}

export function conceptIdentity(mapping: SchemaMapping, key: string): ConceptIdentity | undefined {
  const spec = mapping.concepts?.find((c) => c.key === key)
  if (!spec) return undefined
  const f = spec.fields ?? {}
  const same = (a: FieldSpec | undefined, b: FieldSpec | undefined) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b)
  const custom = !!spec.customSql?.trim()
  const columns = custom ? (spec.sqlColumns ?? Object.keys(f)) : Object.keys(f)
  const ownId = custom
    ? columns.includes('concept_id')
    : !!f.concept_id && !same(f.concept_id, f.concept_code) && !same(f.concept_id, f.concept_name)
  return {
    key,
    ownId,
    hasCode: columns.includes('concept_code'),
    table: spec.from?.table ?? key,
  }
}

/** The mapping with the relation at `specKey` replaced (or removed, with undefined). */
export function withSpec(mapping: SchemaMapping, specKey: string, spec: RelationSpec | undefined): SchemaMapping {
  if (specKey === 'patient' || specKey === 'visit' || specKey === 'visitDetail' || specKey === 'note') {
    const next = { ...mapping }
    if (spec) (next as Record<string, unknown>)[specKey] = spec
    else delete (next as Record<string, unknown>)[specKey]
    return next
  }
  const [list, ...rest] = specKey.split('.')
  const key = rest.join('.')
  if (list === 'concepts') {
    const items = (mapping.concepts ?? []).flatMap((c) => (c.key !== key ? [c] : spec ? [spec as ConceptSpec] : []))
    return { ...mapping, concepts: items }
  }
  if (list === 'events' || list === 'drugs') {
    const current = (list === 'events' ? mapping.events : mapping.drugs) ?? []
    const items = current.flatMap((e) => (e.label !== key ? [e] : spec ? [spec as typeof e] : []))
    return { ...mapping, [list]: items }
  }
  return mapping
}
