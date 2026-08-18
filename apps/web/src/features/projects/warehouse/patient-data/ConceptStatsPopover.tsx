import { useState } from 'react'
import { BarChart3 } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { queryDataSource } from '@/lib/duckdb/engine'
import type { SchemaMapping } from '@/types/schema-mapping'
import {
  buildDomainCountQuery,
  buildValueDistributionQuery,
  buildValueHistogramQuery,
  hasValueColumnForDict,
} from '../concepts/concept-queries'
import { ConceptStatsPanel } from '../concepts/ConceptStatsPanel'
import type {
  ConceptStats,
  MeasurementDistribution,
  HistogramBin,
} from '../concepts/use-concepts'

/** Same P1–P99 clip the Concepts page applies by default, so both histograms
 *  for one concept are the same shape rather than one raw and one clipped. */
const EXCLUDE_OUTLIERS = true

interface ConceptStatsPopoverProps {
  dataSourceId: string | undefined
  schemaMapping: SchemaMapping | undefined
  conceptId: number
  dictKey: string
}

/**
 * Inline metadata trigger for a concept row: loads count + value distribution
 * on first open (cached afterwards) and renders the shared ConceptStatsPanel,
 * mirroring the source-concept detail in the concept-mapping page.
 */
export function ConceptStatsPopover({
  dataSourceId,
  schemaMapping,
  conceptId,
  dictKey,
}: ConceptStatsPopoverProps) {
  const [stats, setStats] = useState<ConceptStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const hasValueColumn =
    !!schemaMapping && hasValueColumnForDict(schemaMapping, dictKey)

  const load = async () => {
    if (loaded || !dataSourceId || !schemaMapping) return
    setLoading(true)
    try {
      const countSql = buildDomainCountQuery(schemaMapping, dictKey, conceptId)
      if (!countSql) {
        setStats(null)
        return
      }
      const countResult = await queryDataSource(dataSourceId, countSql)
      const rowCount = Number(countResult[0]?.cnt ?? 0)

      let distribution: MeasurementDistribution | undefined
      let histogram: HistogramBin[] | undefined

      if (rowCount > 0 && hasValueColumn) {
        try {
          const distSql = buildValueDistributionQuery(schemaMapping, dictKey, conceptId)
          const histSql = buildValueHistogramQuery(schemaMapping, dictKey, conceptId, 20, EXCLUDE_OUTLIERS)
          if (distSql && histSql) {
            const [distRows, histRows] = await Promise.all([
              queryDataSource(dataSourceId, distSql),
              queryDataSource(dataSourceId, histSql),
            ])
            if (distRows.length > 0) {
              distribution = distRows[0] as unknown as MeasurementDistribution
            }
            histogram = histRows as unknown as HistogramBin[]
          }
        } catch {
          // Value queries can fail on non-numeric columns; show count only.
        }
      }

      setStats({ rowCount, distribution, histogram })
    } catch {
      setStats(null)
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }

  return (
    <Popover onOpenChange={(open) => { if (open) load() }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground/60 hover:text-primary"
          onClick={(e) => e.stopPropagation()}
        >
          <BarChart3 size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="max-h-[60vh] w-72 overflow-y-auto p-3"
        align="end"
        side="left"
        collisionPadding={12}
        onClick={(e) => e.stopPropagation()}
      >
        <ConceptStatsPanel
          hasValueColumn={hasValueColumn}
          stats={stats}
          isLoading={loading}
          excludeOutliers={EXCLUDE_OUTLIERS}
          // This popover computes on demand, so stats are always available —
          // unlike the Concepts page, which gates them behind a checkbox.
          statsEnabled
        />
      </PopoverContent>
    </Popover>
  )
}
