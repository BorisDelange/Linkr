import { useState } from 'react'
import { BarChart3 } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { SchemaMapping } from '@/types/schema-mapping'
import { hasValueColumnForDict } from './concept-queries'
import { ConceptStatsPanel } from './ConceptStatsPanel'
import { fetchConceptStats, type ConceptStats } from './use-concepts'

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
 * on first open — from the same caches as the detail panel, precomputed ones
 * included — and renders the shared ConceptStatsPanel, mirroring the
 * source-concept detail in the concept-mapping page.
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
      setStats(await fetchConceptStats(dataSourceId, schemaMapping, conceptId, dictKey, EXCLUDE_OUTLIERS))
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
