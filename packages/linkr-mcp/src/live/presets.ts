/** A schema preset read and edited relation by relation: the pure part of the schema preset tools. */
import { parseDdl } from '@/lib/ddl-parse'
import type { ClassName } from '@/lib/schema-classes/contracts'
import { classRelations } from '@/lib/schema-classes/relations'
import { specAt, specEntries, withSpec } from '@/lib/schema-classes/spec'
import { sanitizeSchemaMapping } from '@/lib/schema-helpers'
import type { DrugKind, ErdGroup, FieldSpec, RelationJoin, RelationSpec, RelationTable, SchemaMapping } from '@/types/schema-mapping'

const SINGLETONS: Record<string, ClassName> = { patient: 'patient', visit: 'visit', visitDetail: 'visit_detail', note: 'note' }
const LISTS: Record<string, ClassName> = { concepts: 'concept', events: 'event', drugs: 'drug' }

export interface RelationKey {
  key: string
  cls: ClassName
  /** `concepts` / `events` / `drugs`; undefined for a singleton class. */
  list?: 'concepts' | 'events' | 'drugs'
  /** Concept key or event / drug label. */
  name?: string
}

/** `note`, `events.Signal`, `drugs.Administrations`… — the key a database override uses too. */
export function parseRelationKey(key: string): RelationKey | string {
  const k = key.trim()
  if (SINGLETONS[k]) return { key: k, cls: SINGLETONS[k] }
  const dot = k.indexOf('.')
  const list = dot > 0 ? k.slice(0, dot) : ''
  const name = dot > 0 ? k.slice(dot + 1).trim() : ''
  if (!LISTS[list] || !name) {
    return `Unknown relation "${key}": use patient, visit, visitDetail, note, concepts.<key>, events.<label> or drugs.<label>.`
  }
  return { key: `${list}.${name}`, cls: LISTS[list], list: list as RelationKey['list'], name }
}

/** What a tool call gives for a relation: each property set replaces the stored one, null removes it. */
export interface RelationInput {
  from?: RelationTable | null
  joins?: RelationJoin[] | null
  where?: string | null
  fields?: Record<string, FieldSpec> | null
  custom_sql?: string | null
  sql_columns?: string[] | null
  drug_kind?: DrugKind | null
  concept_dictionary_key?: string | null
  gender_values?: { male: string; female: string; unknown?: string } | null
}

const INPUT_TO_SPEC: [keyof RelationInput, string][] = [
  ['from', 'from'], ['joins', 'joins'], ['where', 'where'], ['fields', 'fields'], ['custom_sql', 'customSql'],
  ['sql_columns', 'sqlColumns'], ['drug_kind', 'drugKind'], ['concept_dictionary_key', 'conceptDictionaryKey'],
  ['gender_values', 'genderValues'],
]

/**
 * The relation as it will be stored: the input laid over the current spec (or a
 * new one), its key or label set from the relation key. Clearing the SQL also
 * clears the columns measured on it.
 */
export function buildRelationSpec(rk: RelationKey, input: RelationInput, current: RelationSpec | undefined): RelationSpec {
  const out: Record<string, unknown> = { ...(current ?? {}) }
  for (const [from, to] of INPUT_TO_SPEC) {
    if (!(from in input) || input[from] === undefined) continue
    const v = input[from]
    if (v === null || (typeof v === 'string' && !v.trim())) delete out[to]
    else out[to] = v
  }
  if (!out.customSql) delete out.sqlColumns
  if (rk.list === 'concepts') out.key = rk.name
  if (rk.list === 'events' || rk.list === 'drugs') out.label = rk.name
  if (rk.list !== 'drugs') delete out.drugKind
  if (rk.cls !== 'patient') delete out.genderValues
  return out as unknown as RelationSpec
}

/** The mapping with the relation at `rk` set — replaced in place, or appended when new. */
export function putRelation(mapping: SchemaMapping, rk: RelationKey, spec: RelationSpec): SchemaMapping {
  if (!rk.list || specAt(mapping, rk.key)) return withSpec(mapping, rk.key, spec)
  return { ...mapping, [rk.list]: [...((mapping[rk.list] as RelationSpec[] | undefined) ?? []), spec] }
}

/** Why the mapping cannot take this relation as it stands — empty when it can. */
export function relationProblems(mapping: SchemaMapping, rk: RelationKey): string[] {
  const spec = specAt(mapping, rk.key)
  if (!spec) return [`No relation ${rk.key} in the mapping.`]
  const problems: string[] = []
  if (rk.list === 'events' || rk.list === 'drugs') {
    const labels = [...(mapping.events ?? []), ...(mapping.drugs ?? [])].map((e) => e.label)
    if (labels.filter((l) => l === rk.name).length > 1) problems.push(`The label "${rk.name}" is used by another event or drug relation: labels are unique across both.`)
  }
  if (rk.list === 'drugs' && !(spec as { drugKind?: string }).drugKind) problems.push('A drug relation needs drug_kind (administration or prescription).')
  const dict = (spec as { conceptDictionaryKey?: string }).conceptDictionaryKey
  if (dict && dict !== 'none' && !(mapping.concepts ?? []).some((c) => c.key === dict)) {
    problems.push(`concept_dictionary_key "${dict}" names no concept dictionary (concepts.<key>).`)
  }
  const rel = classRelations(sanitizeSchemaMapping(mapping)).find((r) => r.specKey === rk.key)
  if (!rel) problems.push(spec.customSql?.trim() ? 'The relation does not compile.' : 'A visual relation needs `from` (its grain table) — or give custom_sql.')
  else problems.push(...rel.problems)
  return problems
}

const qualified = (t: { schema?: string; table: string }) => (t.schema ? `${t.schema}.${t.table}` : t.table)

function fieldText(v: FieldSpec): string {
  if (typeof v === 'string') return v
  if ('expr' in v) return `expr(${v.expr})`
  return `value(${JSON.stringify(v.value)})`
}

/** One relation, readable: its source, filter and fields, or its SQL. */
export function relationText(cls: ClassName, key: string, spec: RelationSpec, full: boolean): string {
  const s = spec as RelationSpec & { drugKind?: string; conceptDictionaryKey?: string; genderValues?: Record<string, string> }
  const head = [`${key} (${cls})`]
  if (s.drugKind) head.push(`drug_kind ${s.drugKind}`)
  if (s.conceptDictionaryKey) head.push(`dictionary ${s.conceptDictionaryKey}`)
  const lines = [head.join(' · ')]
  if (s.customSql?.trim()) {
    const sql = s.customSql.trim()
    lines.push(full ? `  custom SQL:\n${sql.split('\n').map((l) => `    ${l}`).join('\n')}` : `  custom SQL (${sql.split('\n').length} lines)`)
    if (s.sqlColumns?.length) lines.push(`  sql_columns: ${s.sqlColumns.join(', ')}`)
    if (!full && s.from) lines.push('  (a visual form is kept underneath, unused while the SQL is set)')
  }
  if (!s.customSql?.trim() || full) {
    if (s.from) lines.push(`  from ${qualified(s.from)} ${s.from.alias}`)
    for (const j of s.joins ?? []) lines.push(`  ${j.type} join ${qualified(j)} ${j.alias} on ${j.on.map(([a, b]) => `${a} = ${b}`).join(' and ')}`)
    if (s.where?.trim()) lines.push(`  where ${s.where.trim()}`)
    const fields = Object.entries(s.fields ?? {})
    if (fields.length) lines.push(`  fields: ${fields.map(([f, v]) => `${f} ← ${fieldText(v)}`).join(', ')}`)
  }
  if (s.genderValues) lines.push(`  gender_values: ${JSON.stringify(s.genderValues)}`)
  return lines.join('\n')
}

/** The whole preset, readable: every relation, then what else the mapping carries. */
export function presetText(mapping: SchemaMapping): string {
  const out = specEntries(mapping).map((e) => relationText(e.cls, e.specKey, e.spec, false))
  const tables = mapping.ddl ? parseDdl(mapping.ddl) : []
  out.push('', tables.length
    ? `DDL: ${tables.length} table(s) — ${tables.map((t) => t.name).join(', ')}`
    : 'DDL: none')
  if (mapping.knownTables?.length) out.push(`known_tables: ${mapping.knownTables.join(', ')}`)
  if (mapping.erdGroups?.length) out.push(`erd_groups: ${mapping.erdGroups.map((g) => `${g.id} (${g.tables.length})`).join(', ')}`)
  return out.join('\n')
}

/** What a preset edit gives besides its relations; each property set replaces the stored one. */
export interface PresetPartsInput {
  ddl?: string | null
  known_tables_add?: string[]
  known_tables_remove?: string[]
  erd_groups?: ErdGroup[] | null
}

export function applyPresetParts(mapping: SchemaMapping, input: PresetPartsInput): SchemaMapping {
  const out: SchemaMapping = { ...mapping }
  if (input.ddl !== undefined) {
    if (input.ddl === null || !input.ddl.trim()) delete out.ddl
    else out.ddl = input.ddl
  }
  if (input.known_tables_add?.length || input.known_tables_remove?.length) {
    const drop = new Set((input.known_tables_remove ?? []).map((t) => t.toLowerCase()))
    const kept = (out.knownTables ?? []).filter((t) => !drop.has(t.toLowerCase()))
    const have = new Set(kept.map((t) => t.toLowerCase()))
    out.knownTables = [...kept, ...(input.known_tables_add ?? []).filter((t) => !have.has(t.toLowerCase()))]
  }
  if (input.erd_groups !== undefined) {
    if (input.erd_groups === null) delete out.erdGroups
    else out.erdGroups = input.erd_groups
  }
  return out
}
