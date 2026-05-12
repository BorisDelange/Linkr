import { buildFuzzySearchSql } from '@/lib/fuzzy-search'
import { escSql as esc } from '@/lib/format-helpers'
import type { SchemaMapping } from '@/types/schema-mapping'

export interface SuggestionCandidate {
  concept_id: number
  concept_name: string
  concept_code: string
  vocabulary_id: string
  domain_id?: string
  concept_class_id?: string
  standard_concept?: string
  match_score: number
  provider: string
}

const PROVIDER = 'Syntactic'
const TOP_N = 20

/**
 * Build a DuckDB SQL query that returns the top-N syntactic candidates for
 * `sourceName` using the same multi-tier Jaro-Winkler fuzzy search as the
 * rest of the app.  The `_rank` value (lower = better) is converted to a
 * [0, 1] match_score so the UI can display a progress bar.
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
    `${fuzzy.rankExpr} AS _rank`,
    // Clamp _rank to [0, 6] then invert and normalise to [0, 1].
    // Tier 0 (exact id) _rank ≈ 0, tier 5 (fuzzy) _rank ≈ 5.something
    `ROUND(GREATEST(0.0, 1.0 - (${fuzzy.rankExpr}) / 6.0), 3) AS match_score`,
    `'${esc(PROVIDER)}' AS provider`,
  ].filter(Boolean).join(', ')

  return `SELECT ${selectCols}
FROM ${dict.table} d
WHERE ${fuzzy.where}
ORDER BY _rank
LIMIT ${TOP_N}`
}
