import type { ConceptDictionary, EventTable, SchemaMapping } from '@/types/schema-mapping'
import { isSafeIdentifier } from '@/lib/format-helpers'

// ---------------------------------------------------------------------------
// Trust boundary: schema-mapping identifiers
// ---------------------------------------------------------------------------
//
// Every table/column name in a SchemaMapping is interpolated into SQL as a bare
// `"${name}"` by the query builders (patient-overview-queries, cohort-query,
// concept-queries, patient-data-queries, data-quality, catalog-queries), so a
// single `"` in a name breaks out of the quoting.
//
// These names are NOT developer constants: they are free text in the schema
// editor and arrive verbatim from four untrusted paths — a workspace ZIP, a
// cloned git repo, a manually imported preset, and the seed loader. Validating
// here, once, is what makes the ~100 interpolation sites downstream safe;
// patching each site individually would leave the next one to be written
// unguarded.
//
// A rejected field is dropped rather than rewritten: a mapping that names a
// column `foo"bar` is broken regardless, and silently querying a *different*
// column would be worse than not querying it.

/** Fields holding a SQL identifier, by suffix. Matches `table`, `idColumn`,
 *  `careSiteNameTable`, `valueColumn`, … without enumerating all ~40 of them,
 *  so a field added later is covered by default rather than by remembering.
 *
 *  `schema` is named outright: it is interpolated exactly like a table name but
 *  ends in neither suffix, so the pattern alone would let it through unchecked. */
function isIdentifierField(key: string): boolean {
  return key === 'schema' || /(^|[a-z])(table|column)s?$/i.test(key)
}

/** A `Record<string, string>` whose VALUES are identifiers — `extraColumns`,
 *  where the key is a query alias and the value the real column name. */
function isStringMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  )
}

/** Drop every identifier-valued field that is not a safe SQL identifier.
 *  Recurses into the nested table descriptors, event tables and dictionaries.
 *
 *  The three shapes an identifier field takes must ALL be handled here: a bare
 *  string, a `string[]`, and a `Record<string, string>` whose values are the
 *  identifiers. Matching the field *name* is not enough — `extraColumns` passed
 *  the suffix test, fell through to the recursion, and its values reached SQL
 *  unchecked, because only the first two shapes were covered. */
function sanitizeNode<T>(node: T): T {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((v) => sanitizeNode(v)) as unknown as T

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (isIdentifierField(key)) {
      if (typeof value === 'string') {
        if (isSafeIdentifier(value)) out[key] = value
        continue
      }
      // `knownTables: string[]` and `tables: string[]` (ERD groups) — keep only
      // the safe entries rather than dropping the whole list.
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        out[key] = (value as string[]).filter(isSafeIdentifier)
        continue
      }
      // `extraColumns: Record<alias, columnName>` — the values are what
      // `resolveActualColumn` returns straight into `"${…}"`, so filter on them
      // and keep the alias keys, which never reach SQL.
      if (isStringMap(value)) {
        out[key] = Object.fromEntries(
          Object.entries(value).filter(([, v]) => isSafeIdentifier(v)),
        )
        continue
      }
      // `conceptTables` / `eventTables` are collections of descriptors, not
      // identifiers — the suffix test catches them, so recurse instead.
      out[key] = sanitizeNode(value)
      continue
    }
    out[key] = sanitizeNode(value)
  }
  return out as T
}

/**
 * Validate every SQL identifier in a schema mapping, dropping the unsafe ones.
 * Call this at each point a mapping enters the app from outside (import, clone,
 * seed, manual save) — never trust one that has not been through here.
 */
export function sanitizeSchemaMapping<T extends SchemaMapping | undefined | null>(mapping: T): T {
  if (!mapping || typeof mapping !== 'object') return mapping
  return sanitizeNode(mapping)
}

/** Get the default (first) concept dictionary. */
function getDefaultConceptDictionary(mapping: SchemaMapping): ConceptDictionary | undefined {
  return mapping.conceptTables?.[0]
}

/** Get a concept dictionary by key. */
function getConceptDictionary(mapping: SchemaMapping, key: string): ConceptDictionary | undefined {
  return mapping.conceptTables?.find((d) => d.key === key)
}

/**
 * A table reference for SQL: `"patients"`, or `"hosp"."patients"` when the
 * mapping names a schema.
 *
 * TWO quoted identifiers, never one — `"hosp.patients"` names a table whose name
 * *contains* a dot, which DuckDB reports as missing. That is the bug this whole
 * area exists to avoid, and it is silent wherever the caller turns an error into
 * an empty result.
 *
 * Names are already validated by `sanitizeSchemaMapping`, so quoting here is
 * belt-and-braces rather than the trust boundary.
 */
export function qualify(ref: { schema?: string; table: string }): string {
  const table = `"${ref.table}"`
  return ref.schema ? `"${ref.schema}".${table}` : table
}

type PatientTable = NonNullable<SchemaMapping['patientTable']>

/**
 * The patient's birth year as SQL, or null when the mapping cannot tell it: the
 * birth-year column, else MIMIC-IV's anchor pair (`anchor_year - anchor_age`).
 * Without the anchor pair every age on MIMIC-IV was unknown, and an age
 * criterion compiled to `1=1` — it kept everyone, silently.
 */
export function birthYearSql(pt: PatientTable | undefined, alias?: string): string | null {
  if (!pt) return null
  const col = (c: string) => (alias ? `${alias}."${c}"` : `"${c}"`)
  if (pt.birthYearColumn) return col(pt.birthYearColumn)
  if (pt.anchorYearColumn && pt.anchorAgeColumn) return `(${col(pt.anchorYearColumn)} - ${col(pt.anchorAgeColumn)})`
  return null
}

/** The columns `birthYearSql` reads, for a GROUP BY. */
export function birthYearColumns(pt: PatientTable | undefined): string[] {
  if (!pt) return []
  if (pt.birthYearColumn) return [pt.birthYearColumn]
  return pt.anchorYearColumn && pt.anchorAgeColumn ? [pt.anchorYearColumn, pt.anchorAgeColumn] : []
}

/**
 * Does a discovered table list contain this table?
 *
 * `discoverTables` reports QUALIFIED names (`icu.d_items`) wherever the source
 * carries module directories or schemas — the server derives them that way, and the
 * WASM path mirrors it. A mapping stores the two halves separately, so comparing
 * against `ref.table` alone silently misses every table in a schema: on MIMIC-IV
 * that meant the Concepts page deciding the dictionary did not exist while its
 * cache held thousands of rows.
 *
 * The unqualified name is still accepted, since a flat import reports it that way.
 * Case-insensitive: DuckDB lowercases the schemas it derives from directories,
 * while a mapping keeps whatever the preset author typed.
 */
export function tableListHas(tables: readonly string[], ref: { schema?: string; table: string }): boolean {
  const wanted = new Set<string>([ref.table.toLowerCase()])
  if (ref.schema) wanted.add(`${ref.schema.toLowerCase()}.${ref.table.toLowerCase()}`)
  return tables.some((t) => wanted.has(t.toLowerCase()))
}

/**
 * Same, for a lookup table named by a sibling field (`careSiteNameTable`,
 * `unitNameTable`): it has no `schema` of its own, so it inherits the one of the
 * descriptor that names it — they come from the same source, and a lookup in a
 * different schema than its table would need its own field.
 */
export function qualifyIn(ref: { schema?: string }, table: string | undefined): string {
  // `undefined` is accepted because every call sits behind a guard that already
  // checked the field (`hasLookup`), which TypeScript cannot narrow through a
  // boolean. Emitting `""` there would be a syntax error, not a wrong table, so
  // it surfaces immediately rather than querying something unintended.
  return qualify({ schema: ref.schema, table: table ?? '' })
}

/** Get the concept dictionary for a given event table. */
export function getDictionaryForEvent(mapping: SchemaMapping, eventTable: EventTable): ConceptDictionary | undefined {
  // 'none' is an explicit opt-out, distinct from "omitted": a table naming its
  // concept inline has no dictionary to join, and falling back to the default
  // one would join a drug name against a numeric id.
  if (eventTable.conceptDictionaryKey === 'none') return undefined
  if (eventTable.conceptDictionaryKey) {
    return getConceptDictionary(mapping, eventTable.conceptDictionaryKey)
  }
  return getDefaultConceptDictionary(mapping)
}

/**
 * Get all event tables that reference a specific concept dictionary.
 * If dictKey matches the default (first) dictionary, also includes event tables with no explicit conceptDictionaryKey.
 */
export function getEventTablesForDictionary(
  mapping: SchemaMapping,
  dictKey: string,
): { label: string; eventTable: EventTable }[] {
  if (!mapping.eventTables) return []
  const defaultDict = getDefaultConceptDictionary(mapping)
  const isDefault = defaultDict?.key === dictKey

  return Object.entries(mapping.eventTables)
    .filter(([, et]) => {
      if (et.conceptDictionaryKey) return et.conceptDictionaryKey === dictKey
      return isDefault
    })
    .map(([label, eventTable]) => ({ label, eventTable }))
}

/**
 * Build a SQL JOIN condition between an event table and its concept dictionary.
 * Handles both simple FK joins and composite (vocabulary+code) joins.
 *
 * @param eventAlias - SQL alias for the event table (e.g. 'e')
 * @param dictAlias - SQL alias for the concept dictionary table (e.g. 'c')
 * @param et - EventTable definition
 * @param dict - ConceptDictionary definition
 * @returns SQL ON clause content (without the 'ON' keyword)
 */
export function buildConceptJoinCondition(
  eventAlias: string,
  dictAlias: string,
  et: EventTable,
  dict: ConceptDictionary,
): string {
  // Composite join: vocabulary + code columns (e.g. eHOP)
  if (et.conceptVocabularyColumn && et.conceptCodeColumn && dict.vocabularyColumn && dict.codeColumn) {
    return `${eventAlias}."${et.conceptVocabularyColumn}" = ${dictAlias}."${dict.vocabularyColumn}" AND ${eventAlias}."${et.conceptCodeColumn}" = ${dictAlias}."${dict.codeColumn}"`
  }
  // Simple FK join (OMOP, MIMIC, CoDOC)
  return `${eventAlias}."${et.conceptIdColumn}" = ${dictAlias}."${dict.idColumn}"`
}

/**
 * Build a SQL WHERE condition to match a concept in an event table.
 * For simple FK: WHERE conceptIdColumn = :conceptId (OR sourceConceptIdColumn = :conceptId)
 * For composite: WHERE vocabularyColumn = :vocab AND codeColumn = :code
 */
export function buildConceptMatchCondition(
  tableAlias: string,
  et: EventTable,
  conceptIdExpr: string,
): string {
  const conditions: string[] = []
  conditions.push(`${tableAlias}."${et.conceptIdColumn}" = ${conceptIdExpr}`)
  if (et.sourceConceptIdColumn) {
    conditions.push(`${tableAlias}."${et.sourceConceptIdColumn}" = ${conceptIdExpr}`)
  }
  return conditions.join(' OR ')
}
