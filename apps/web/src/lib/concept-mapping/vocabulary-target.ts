import type { ConceptSpec, SchemaMapping } from '@/types/schema-mapping'
import { conceptRelation, type ClassRelation } from '@/lib/schema-classes/relations'

/** The database target concepts are searched in, with the table to search. */
export interface VocabularyTarget {
  dsId: string
  /** The database's mapping with the target concept dictionary first, since the
   *  search builders read the first dictionary. */
  mapping: SchemaMapping
  /** The target dictionary's relation. */
  dictionary: ClassRelation
  conceptTable: string
}

interface DataSourceLike {
  id: string
  schemaMapping?: SchemaMapping | null
}

/** An OMOP vocabulary table: `concept` itself, or one mapped with a standard_concept column. */
export function isOmopConceptTable(spec: ConceptSpec): boolean {
  return spec.from?.table === 'concept' || !!spec.fields?.extra_standard_concept
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
  const concepts = mapping?.concepts ?? []
  if (!ds || !mapping || concepts.length === 0) return null
  const index = Math.max(0, concepts.findIndex(isOmopConceptTable))
  const dictionary = conceptRelation(mapping, concepts[index].key)
  if (!dictionary) return null
  return {
    dsId: ds.id,
    mapping: { ...mapping, concepts: [concepts[index], ...concepts.filter((_, i) => i !== index)] },
    dictionary,
    conceptTable: concepts[index].from?.table ?? 'concept',
  }
}
