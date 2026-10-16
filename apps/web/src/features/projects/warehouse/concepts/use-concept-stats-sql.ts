import { useMemo } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'
import {
  hasValueColumnForDict,
  buildDomainCountQuery,
  buildValueDistributionQuery,
  buildValueHistogramQuery,
} from './concept-queries'
import type { ConceptRow } from './use-concepts'

export interface ConceptStatsSql {
  hasValueColumn: boolean
  statsSql: { titleKey: string; sql: string }[]
}

/**
 * What `ConceptDetail` needs besides the loaded stats: whether the selected
 * concept's dictionary has a value column, and the statements behind its stats
 * panel — rebuilt for display from the same pure builders the loader calls,
 * never a transcript of what ran (in server mode a shared cache may answer
 * without querying at all).
 */
export function useConceptStatsSql(
  mapping: SchemaMapping | undefined,
  concepts: ConceptRow[],
  selectedConceptId: number | null,
  excludeOutliers: boolean,
): ConceptStatsSql {
  return useMemo(() => {
    if (!mapping || selectedConceptId === null) return { hasValueColumn: false, statsSql: [] }
    const row = concepts.find((c) => c.concept_id === selectedConceptId)
    const dictKey = (row?._dict_key as string) ?? mapping.concepts?.[0]?.key
    if (!dictKey) return { hasValueColumn: false, statsSql: [] }

    const hasValueColumn = hasValueColumnForDict(mapping, dictKey)
    const statsSql: { titleKey: string; sql: string }[] = []
    const count = buildDomainCountQuery(mapping, dictKey, selectedConceptId)
    if (count) statsSql.push({ titleKey: 'concepts.stats_sql_count', sql: count })
    if (hasValueColumn) {
      // Same order as the panel: histogram, then the summary numbers.
      const hist = buildValueHistogramQuery(mapping, dictKey, selectedConceptId, 20, excludeOutliers)
      if (hist) statsSql.push({ titleKey: 'concepts.stats_sql_histogram', sql: hist })
      const dist = buildValueDistributionQuery(mapping, dictKey, selectedConceptId)
      if (dist) statsSql.push({ titleKey: 'concepts.stats_sql_distribution', sql: dist })
    }
    return { hasValueColumn, statsSql }
  }, [mapping, selectedConceptId, concepts, excludeOutliers])
}
