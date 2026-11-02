import { useMemo } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'
import { prepareQuerySql } from '@/lib/duckdb/engine'
import { toNativeSql } from '@/lib/schema-classes/native-sql'
import {
  hasValueColumnForDict,
  buildDomainCountQuery,
  buildValueDistributionQuery,
  buildValueHistogramQuery,
} from './concept-queries'
import type { ConceptRow } from './use-concepts'

/** One statement behind the stats panel, in the three forms the dialog shows. */
export interface StatsSqlQuery {
  titleKey: string
  /** On the Linkr relations (`linkr_*`): portable across schemas. */
  sql: string
  /** Rewritten on the database's own tables; null when it does not translate. */
  native: string | null
  /** As sent to the database: the relations it reads written in as CTEs. */
  sent: () => Promise<string>
}

export interface ConceptStatsSql {
  hasValueColumn: boolean
  statsSql: StatsSqlQuery[]
}

/**
 * What `ConceptDetail` needs besides the loaded stats: whether the selected
 * concept's dictionary has a value column, and the statements behind its stats
 * panel — rebuilt for display from the same pure builders the loader calls,
 * never a transcript of what ran (in server mode a shared cache may answer
 * without querying at all).
 */
export function useConceptStatsSql(
  dataSourceId: string | undefined,
  mapping: SchemaMapping | undefined,
  concepts: ConceptRow[],
  selectedConceptId: number | null,
  excludeOutliers: boolean,
): ConceptStatsSql {
  return useMemo(() => {
    if (!dataSourceId || !mapping || selectedConceptId === null) return { hasValueColumn: false, statsSql: [] }
    const row = concepts.find((c) => c.concept_id === selectedConceptId)
    const dictKey = (row?._dict_key as string) ?? mapping.concepts?.[0]?.key
    if (!dictKey) return { hasValueColumn: false, statsSql: [] }

    const hasValueColumn = hasValueColumnForDict(mapping, dictKey)
    const statsSql: StatsSqlQuery[] = []
    const add = (titleKey: string, sql: string | null) => {
      if (sql) statsSql.push({ titleKey, sql, native: toNativeSql(sql, mapping), sent: () => prepareQuerySql(dataSourceId, sql) })
    }
    add('concepts.stats_sql_count', buildDomainCountQuery(mapping, dictKey, selectedConceptId))
    if (hasValueColumn) {
      // Same order as the panel: histogram, then the summary numbers.
      add('concepts.stats_sql_histogram', buildValueHistogramQuery(mapping, dictKey, selectedConceptId, 20, excludeOutliers))
      add('concepts.stats_sql_distribution', buildValueDistributionQuery(mapping, dictKey, selectedConceptId))
    }
    return { hasValueColumn, statsSql }
  }, [dataSourceId, mapping, selectedConceptId, concepts, excludeOutliers])
}
