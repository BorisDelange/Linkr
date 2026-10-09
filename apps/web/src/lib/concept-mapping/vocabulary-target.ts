import type { ConceptSpec, SchemaMapping } from '@/types/schema-mapping'
import { conceptRelation, type ClassRelation } from '@/lib/schema-classes/relations'
import { vocabularyDataSourceIdFor } from '@/lib/vocabulary-library/resolve'

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
  workspaceId?: string | null
  isVocabularyReference?: boolean
  connectionConfig?: unknown
  schemaMapping?: SchemaMapping | null
}

/** An OMOP vocabulary table: `concept` itself, or one mapped with a standard_concept column. */
export function isOmopConceptTable(spec: ConceptSpec): boolean {
  return spec.from?.table === 'concept' || !!spec.fields?.extra_standard_concept
}

/**
 * Where a mapping project's target concepts live: the workspace vocabulary
 * library, or the project's own older vocabulary database. Never the source
 * database: its OMOP concept table would be searched live, on the warehouse, at
 * every keystroke, and a native schema offered its own dictionary (`d_items`)
 * as a target vocabulary. With neither, there is no target and the panel says
 * to import one.
 *
 * In the vocabulary database the OMOP concept table comes first; one with no
 * OMOP table keeps its first dictionary (a custom target vocabulary).
 */
export function resolveVocabularyTarget(
  project: { workspaceId?: string | null; vocabularyDataSourceId?: string | null },
  dataSources: DataSourceLike[],
): VocabularyTarget | null {
  const vocabId = vocabularyDataSourceIdFor(project, dataSources)
  const ds = vocabId ? dataSources.find((d) => d.id === vocabId) : null
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
