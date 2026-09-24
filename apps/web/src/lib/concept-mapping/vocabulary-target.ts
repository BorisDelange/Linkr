import type { ConceptDictionary, SchemaMapping } from '@/types/schema-mapping'

/** The database target concepts are searched in, with the table to search. */
export interface VocabularyTarget {
  dsId: string
  /** The database's mapping with the target concept table first, since the
   *  search builders read `conceptTables[0]`. */
  mapping: SchemaMapping
  /** The target concept table's dictionary entry (`mapping.conceptTables[0]`). */
  dictionary: ConceptDictionary
  conceptTable: string
}

interface DataSourceLike {
  id: string
  schemaMapping?: SchemaMapping | null
}

/** An OMOP vocabulary table: `concept` itself, or one mapped with a standard_concept column. */
export function isOmopConceptTable(t: Pick<ConceptDictionary, 'table' | 'extraColumns'>): boolean {
  return t.table === 'concept' || !!t.extraColumns?.standard_concept
}

/**
 * Where a mapping project's target concepts live: its vocabulary database, else
 * the source database. In that database the OMOP concept table comes first — a
 * source database such as MIMIC lists its own dictionaries (`d_items`) before
 * any vocabulary, and querying those as targets finds nothing. A database with
 * no OMOP table keeps its first dictionary (a custom target vocabulary).
 */
export function resolveVocabularyTarget(
  project: { vocabularyDataSourceId?: string | null },
  sourceDataSource: DataSourceLike | null | undefined,
  dataSources: DataSourceLike[],
): VocabularyTarget | null {
  const vocabDs = project.vocabularyDataSourceId
    ? dataSources.find((ds) => ds.id === project.vocabularyDataSourceId)
    : null
  const ds = vocabDs ?? sourceDataSource
  const mapping = ds?.schemaMapping
  const tables = mapping?.conceptTables ?? []
  if (!ds || !mapping || tables.length === 0) return null
  const index = Math.max(0, tables.findIndex(isOmopConceptTable))
  return {
    dsId: ds.id,
    mapping: { ...mapping, conceptTables: [tables[index], ...tables.filter((_, i) => i !== index)] },
    dictionary: tables[index],
    conceptTable: tables[index].table ?? 'concept',
  }
}
