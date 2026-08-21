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
 *  so a field added later is covered by default rather than by remembering. */
function isIdentifierField(key: string): boolean {
  return /(^|[a-z])(table|column)s?$/i.test(key)
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
