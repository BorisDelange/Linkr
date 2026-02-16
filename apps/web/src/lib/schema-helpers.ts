import type { ConceptDictionary, EventTable, SchemaMapping } from '@/types/schema-mapping'

/** Get the default (first) concept dictionary. */
export function getDefaultConceptDictionary(mapping: SchemaMapping): ConceptDictionary | undefined {
  return mapping.conceptTables?.[0]
}

/** Get a concept dictionary by key. */
export function getConceptDictionary(mapping: SchemaMapping, key: string): ConceptDictionary | undefined {
  return mapping.conceptTables?.find((d) => d.key === key)
}

/** Get the concept dictionary for a given event table. */
export function getDictionaryForEvent(mapping: SchemaMapping, eventTable: EventTable): ConceptDictionary | undefined {
  if (eventTable.conceptDictionaryKey) {
    return getConceptDictionary(mapping, eventTable.conceptDictionaryKey)
  }
  return getDefaultConceptDictionary(mapping)
}

/** Get all event table labels. */
export function getEventTableLabels(mapping: SchemaMapping): string[] {
  return mapping.eventTables ? Object.keys(mapping.eventTables) : []
}

/** Get an event table by label. */
export function getEventTable(mapping: SchemaMapping, label: string): EventTable | undefined {
  return mapping.eventTables?.[label]
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
