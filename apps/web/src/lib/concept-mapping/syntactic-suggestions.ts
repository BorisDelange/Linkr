import { buildFuzzySearchSql } from '@/lib/fuzzy-search'
import { escSql as esc } from '@/lib/format-helpers'
import type { SchemaMapping } from '@/types/schema-mapping'

export interface MethodScore {
  provider: string
  score: number
  weight: number
}

export interface SuggestionCandidate {
  concept_id: number
  concept_name: string
  concept_code: string
  vocabulary_id: string
  domain_id?: string
  concept_class_id?: string
  standard_concept?: string
  /** Per-method scores. The combined score is the weighted average. */
  scores: MethodScore[]
  /** Weighted average of all method scores. */
  combined_score: number
}

export const METHOD_COLORS: Record<string, string> = {
  Syntaxique:  'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400',
  Sémantique:  'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400',
  Statistique: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400',
  IA:          'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
}

export const METHOD_DOT_COLORS: Record<string, string> = {
  Syntaxique:  'bg-sky-500',
  Sémantique:  'bg-violet-500',
  Statistique: 'bg-orange-500',
  IA:          'bg-emerald-500',
}

export const SYNTACTIC_PROVIDER = 'Syntaxique'
const TOP_N = 20

/**
 * Build a DuckDB SQL query that returns the top-N syntactic candidates for
 * `sourceName` using the same multi-tier Jaro-Winkler fuzzy search as the
 * rest of the app.
 */
export function buildSyntacticSuggestionsQuery(
  sourceName: string,
  mapping: SchemaMapping,
): string | null {
  const dicts = mapping.conceptTables ?? []
  if (dicts.length === 0 || !sourceName.trim()) return null

  const dict = dicts[0]
  const idCol = dict.idColumn ?? 'concept_id'
  const nameCol = dict.nameColumn ?? 'concept_name'
  const codeCol = dict.codeColumn ?? 'concept_code'
  const vocabCol = dict.terminologyIdColumn ?? dict.vocabularyColumn ?? 'vocabulary_id'
  const domainCol = dict.extraColumns?.domain_id ?? dict.categoryColumn
  const classCol = dict.extraColumns?.concept_class_id ?? dict.subcategoryColumn
  const stdCol = dict.extraColumns?.standard_concept

  const fuzzy = buildFuzzySearchSql(sourceName.trim(), {
    nameColumn: nameCol,
    codeColumn: codeCol,
    idColumn: idCol,
    alias: 'd',
  })
  if (!fuzzy) return null

  const selectCols = [
    `d.${idCol} AS concept_id`,
    `d.${nameCol} AS concept_name`,
    `d.${codeCol} AS concept_code`,
    `d.${vocabCol} AS vocabulary_id`,
    domainCol ? `d.${domainCol} AS domain_id` : null,
    classCol ? `d.${classCol} AS concept_class_id` : null,
    stdCol ? `d.${stdCol} AS standard_concept` : null,
    `ROUND(GREATEST(0.0, 1.0 - (${fuzzy.rankExpr}) / 6.0), 3) AS syntactic_score`,
  ].filter(Boolean).join(', ')

  return `SELECT ${selectCols}
FROM ${dict.table} d
WHERE ${fuzzy.where}
ORDER BY syntactic_score DESC
LIMIT ${TOP_N}`
}

/** Convert a raw SQL row (with `syntactic_score`) into a `SuggestionCandidate`. */
export function rowToCandidate(row: Record<string, unknown>): SuggestionCandidate {
  const syntScore = Number(row.syntactic_score ?? 0)
  return {
    concept_id: Number(row.concept_id),
    concept_name: String(row.concept_name ?? ''),
    concept_code: String(row.concept_code ?? ''),
    vocabulary_id: String(row.vocabulary_id ?? ''),
    domain_id: row.domain_id != null ? String(row.domain_id) : undefined,
    concept_class_id: row.concept_class_id != null ? String(row.concept_class_id) : undefined,
    standard_concept: row.standard_concept != null ? String(row.standard_concept) : undefined,
    scores: [{ provider: SYNTACTIC_PROVIDER, score: syntScore, weight: 1 }],
    combined_score: syntScore,
  }
}
