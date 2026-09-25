/**
 * Canonical ordering for a schema mapping.
 *
 * A schema preset's `eventTables` is a user-keyed map of user-keyed objects, so
 * its insertion order carries no meaning — but it is written to git, where an
 * arbitrary order makes a re-export churn the diff even when nothing changed.
 * Sorting everything alphabetically would fix that and scatter the pairs
 * (`dateColumn` far from `endDateColumn`, a unit far from its value), so the
 * field order is declared, grouped by what the fields mean, and anything
 * unlisted is appended sorted — a new field is stable before it is placed here.
 *
 * Two shapes: format v2 (`formatVersion: 2`, one relation per class), the only
 * one the app writes, and v1 (one block per table), still read from trees
 * published before it.
 *
 * **This has three implementations that must emit identical bytes**: this one,
 * `canonicalSchemaMapping` in `apps/web/src/lib/entity-io.ts`, and
 * `_canonical_schema_mapping` in `apps/api/.../workspace_export_assemble.py`.
 * The app re-exports this module's constant rather than keeping its own copy;
 * the Python twin is guarded by the export golden tests.
 */

/**
 * Top-level mapping keys in declared order.
 *
 * Follows what a reader looks for: identity, then the tables that anchor a
 * record (patient → death → visit → note → visit detail), then the concept
 * tables and events, then the lookups and presentation. Every preset the app
 * has exported already uses this order — declaring it here is what lets the
 * authoring writer reproduce an existing preset byte for byte instead of
 * emitting its own arrangement and churning the diff.
 */
export const MAPPING_FIELD_ORDER = [
  'presetId',
  'presetLabel',
  'patientTable',
  'deathTable',
  'visitTable',
  'noteTable',
  'visitDetailTable',
  'conceptTables',
  'eventTables',
  'genderValues',
  'knownTables',
  'erdGroups',
  'templateId',
  'description',
] as const

/** Event-table fields in declared order; unlisted keys are appended sorted. */
export const EVENT_TABLE_FIELD_ORDER = [
  // Ahead of `table` because it qualifies it: `schema` would otherwise be sorted
  // in among the columns, splitting the table reference across the file.
  'schema',
  'table',
  'conceptIdColumn',
  'sourceConceptIdColumn',
  'conceptVocabularyColumn',
  'conceptCodeColumn',
  'conceptDictionaryKey',
  'patientIdColumn',
  'dateColumn',
  'endDateColumn',
  'valueColumn',
  'valueStringColumn',
  'valueUnitColumn',
  'valueUnitConceptIdColumn',
  'routeColumn',
  'routeConceptIdColumn',
] as const

/** One object's keys in a declared order, with unlisted keys appended sorted. */
export function orderKeys(
  obj: Record<string, unknown>,
  order: readonly string[],
): Record<string, unknown> {
  const rest = Object.keys(obj).filter((k) => !order.includes(k)).sort()
  const out: Record<string, unknown> = {}
  for (const k of [...order, ...rest]) if (k in obj) out[k] = obj[k]
  return out
}

/**
 * A mapping with its top-level keys, its event tables, and their keys in a
 * deterministic order.
 *
 * The top level is ordered here, not just at the call sites that remember to:
 * a mapping is assembled by spreading, and a spread appends keys the source
 * lacked. `reassemblePresetMapping` re-adds `presetId`/`presetLabel` after
 * spreading (a preset's repo keeps them in entity.json, not in mapping.json),
 * so an installed database wrote them at the END of its copy while the same
 * mapping exported anywhere else had them first — a pure reordering diff on a
 * file nothing had edited.
 */
export function canonicalSchemaMapping(
  mapping: Record<string, unknown>,
): Record<string, unknown> {
  if (mapping.formatVersion === 2) return canonicalSchemaMappingV2(mapping)
  // A v1 mapping (published before format v2) is still read, and ordered the way
  // it was written; the app converts it on import and only ever writes v2.
  const out = orderKeys(mapping, MAPPING_FIELD_ORDER)
  const tables = out.eventTables
  if (!tables || typeof tables !== 'object') return out
  const src = tables as Record<string, Record<string, unknown>>
  const ordered: Record<string, unknown> = {}
  // Table labels sorted too: they are a user-keyed map, so their insertion order
  // is just as arbitrary as the fields'.
  for (const label of Object.keys(src).sort()) {
    const et = src[label]
    // A null or non-object entry is passed through rather than ordered, which is
    // what the server twin does. Throwing here instead meant a hand-edited or
    // partially-written preset exported fine from the server and not at all
    // from the browser.
    ordered[label] = et && typeof et === 'object' ? orderKeys(et, EVENT_TABLE_FIELD_ORDER) : et
  }
  return { ...out, eventTables: ordered }
}

// ---------------------------------------------------------------------------
// Format v2: one relation per class (see the app's `SchemaMapping`)
// ---------------------------------------------------------------------------

/** Top-level keys of a v2 mapping, in declared order. */
export const MAPPING_V2_FIELD_ORDER = [
  'formatVersion',
  'presetId',
  'presetLabel',
  'patient',
  'visit',
  'visitDetail',
  'note',
  'concepts',
  'events',
  'drugs',
  'params',
  'knownTables',
  'erdGroups',
  'description',
] as const

/** Keys of one relation: what names it, how it is read, then its columns. */
export const RELATION_FIELD_ORDER = [
  'key',
  'label',
  'drugKind',
  'conceptDictionaryKey',
  'genderValues',
  'from',
  'joins',
  'where',
  'fields',
  'customSql',
  'sqlColumns',
] as const

const TABLE_FIELD_ORDER = ['type', 'schema', 'table', 'alias', 'on'] as const
const PARAM_FIELD_ORDER = ['default', 'label', 'description'] as const

/**
 * Contract columns per relation key, in contract order — so `fields` reads like
 * the contract. A mirror of the app's `CLASS_CONTRACTS` (a test there keeps the
 * two equal); an unlisted field is appended sorted, like everywhere else.
 */
export const RELATION_COLUMN_ORDER: Record<string, readonly string[]> = {
  patient: ['patient_id', 'birth_date', 'birth_year', 'gender', 'gender_source_value', 'death_datetime'],
  visit: ['visit_id', 'patient_id', 'start_datetime', 'end_datetime', 'visit_type', 'care_site_id', 'care_site_name'],
  visitDetail: ['visit_detail_id', 'visit_id', 'patient_id', 'start_datetime', 'end_datetime', 'unit_id', 'unit_name', 'unit_category'],
  note: ['note_id', 'patient_id', 'visit_id', 'note_datetime', 'title', 'text', 'note_type'],
  concepts: ['concept_id', 'concept_terminology', 'concept_name', 'concept_code', 'terminology_id', 'terminology_name', 'category', 'subcategory'],
  events: [
    'patient_id', 'concept_id', 'start_datetime', 'visit_id', 'visit_detail_id', 'concept_terminology', 'concept_code',
    'source_concept_id', 'concept_name', 'end_datetime', 'value_number', 'value_string', 'unit', 'unit_concept_id',
    'route', 'route_concept_id',
  ],
  drugs: [
    'patient_id', 'concept_id', 'start_datetime', 'drug_kind', 'drug_id', 'visit_id', 'visit_detail_id',
    'concept_terminology', 'concept_code', 'source_concept_id', 'concept_name', 'end_datetime', 'value_number',
    'value_string', 'unit', 'unit_concept_id', 'quantity', 'amount_value', 'amount_unit', 'rate_value', 'rate_unit',
    'concentration_value', 'concentration_unit', 'duration_value', 'duration_unit', 'is_continuous', 'route',
    'route_concept_id', 'dose_source_value',
  ],
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function canonicalRelation(rel: unknown, columns: readonly string[]): unknown {
  if (!isObj(rel)) return rel
  const out = orderKeys(rel, RELATION_FIELD_ORDER)
  if (isObj(out.from)) out.from = orderKeys(out.from, TABLE_FIELD_ORDER)
  if (Array.isArray(out.joins)) out.joins = out.joins.map((j) => (isObj(j) ? orderKeys(j, TABLE_FIELD_ORDER) : j))
  if (isObj(out.fields)) out.fields = orderKeys(out.fields, columns)
  return out
}

/** A v2 mapping in deterministic order. Arrays keep their order: the first
 *  dictionary is the default one, and relation order is what the user set. */
export function canonicalSchemaMappingV2(mapping: Record<string, unknown>): Record<string, unknown> {
  const out = orderKeys(mapping, MAPPING_V2_FIELD_ORDER)
  for (const key of ['patient', 'visit', 'visitDetail', 'note']) {
    if (key in out) out[key] = canonicalRelation(out[key], RELATION_COLUMN_ORDER[key])
  }
  for (const key of ['concepts', 'events', 'drugs']) {
    const list = out[key]
    if (Array.isArray(list)) out[key] = list.map((r) => canonicalRelation(r, RELATION_COLUMN_ORDER[key]))
  }
  if (isObj(out.params)) {
    const params = out.params
    out.params = Object.fromEntries(
      Object.keys(params).sort().map((k) => [k, isObj(params[k]) ? orderKeys(params[k] as Record<string, unknown>, PARAM_FIELD_ORDER) : params[k]]),
    )
  }
  return out
}

/** Relation list or singleton key of a spec key: `events.Labs` → `events`. */
function relationGroup(specKey: string): string {
  return specKey.split('.')[0]
}

/** One relation in canonical order, as it sits in a v2 mapping under `specKey`
 *  (`visit`, `events.<label>`…). */
export function canonicalRelationSpec(specKey: string, rel: unknown): unknown {
  return canonicalRelation(rel, RELATION_COLUMN_ORDER[relationGroup(specKey)] ?? [])
}

/**
 * A database's `mapping-overrides.json` in deterministic order: parameter values
 * and relations sorted by name, each relation canonical, then the base
 * fingerprints. Twin of `_canonical_schema_overrides` (Python).
 */
export function canonicalSchemaOverrides(overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const sorted = (o: unknown, f: (k: string, v: unknown) => unknown = (_k, v) => v) =>
    isObj(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, f(k, o[k])])) : o
  if (overrides.params !== undefined) out.params = sorted(overrides.params)
  if (overrides.relations !== undefined) out.relations = sorted(overrides.relations, canonicalRelationSpec)
  if (overrides.baseAtOverride !== undefined) out.baseAtOverride = sorted(overrides.baseAtOverride)
  for (const k of Object.keys(overrides).sort()) if (!(k in out)) out[k] = overrides[k]
  return out
}
