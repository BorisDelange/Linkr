/**
 * Classify the files of an OHDSI vocabulary folder (ATHENA download).
 *
 * Every OMOP vocabulary table is accepted so a complete folder can be imported
 * whole: the mapping UI reads only `concept` (+ ancestor/relationship/synonym for
 * expansion and synonyms), but an ETL pipeline copies the metadata tables
 * (`vocabulary`, `domain`, `concept_class`, `relationship`) into its OMOP target,
 * and a script that reads a table the reference does not hold fails at run time.
 */

/** Accepted vocabulary tables, in the order the import list shows them. */
export const VOCAB_TABLES = [
  'concept',
  'concept_ancestor',
  'concept_class',
  'concept_relationship',
  'concept_synonym',
  'domain',
  'drug_strength',
  'relationship',
  'vocabulary',
] as const

/** Without this table there is nothing to map against. */
export const REQUIRED_VOCAB_TABLE = 'concept'

/** OMOP table a file maps to: `INDICATE/CONCEPT.parquet` -> `concept`. */
export function tableNameOf(name: string): string {
  return name.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
}

/** Whether a file is one of the accepted vocabulary tables. */
export function isVocabFile(name: string): boolean {
  return (VOCAB_TABLES as readonly string[]).includes(tableNameOf(name))
}

/** Whether a file is the required CONCEPT table. */
export function isConceptFile(name: string): boolean {
  return tableNameOf(name) === REQUIRED_VOCAB_TABLE
}

/**
 * Order for the import list: the required table first, then alphabetically so
 * the list does not reshuffle between folders.
 */
export function compareVocabFiles(a: string, b: string): number {
  const rank = (n: string) => (isConceptFile(n) ? 0 : 1)
  return rank(a) - rank(b) || tableNameOf(a).localeCompare(tableNameOf(b))
}
