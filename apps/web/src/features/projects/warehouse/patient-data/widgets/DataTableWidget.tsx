import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ChartTooltipCard, FloatingChartTooltip } from '@/features/projects/lab/datasets/analyses/chart-tooltip'
import { fetchConceptLabels } from '@/features/projects/warehouse/cohorts/concept-labels'
import {
  buildDataTableBoundsQuery,
  buildDataTableDensityQuery,
  buildDataTableQuery,
  type DataTableAggregate,
} from '@/lib/duckdb/patient-datatable-queries'
import { toMs } from '@/lib/duckdb/value-coercion'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { usePatientChartContext } from '../PatientChartContext'
import { usePatientScope } from '../use-patient-scope'
import { useTabVisible } from '../TabVisibilityContext'
import { formatApiError } from '@/lib/api-client'
import { isQueryStopped } from '@/lib/api/query-stopped'
import { patientQuery } from '../patient-prefetch'
import { relationsHoldingConcepts } from '../timeline-relations'
import {
  broadcastTimelineRange,
  forgetTimelineRange,
  getTimelineRange,
  subscribeTimelineSync,
  syncChannel,
} from '../timeline-sync'
import { isoOrNull } from './use-overview-data'
import { DataTableRangeStrip } from './DataTableRangeStrip'
import { columnStartLabel, columnsOf, durationLabel, formatCell, periodLabel, type DataTableWindow } from './datatable-columns'

interface DataTableWidgetProps {
  widgetId: string
  /** The config to render: the editor's preview passes its unsaved draft. */
  config?: Record<string, unknown>
  onConfigureConcepts?: () => void
}

interface DataTableConfig {
  conceptIds?: number[]
  columns?: number | string
  aggregate?: DataTableAggregate
  syncTimeRange?: boolean
  showCounts?: boolean
}

interface Cell {
  value: number | null
  text: string | null
  n: number
}

interface Hover {
  x: number
  y: number
  concept: number
  col: number
}

const DEFAULT_COLUMNS = 8
const NAME_WIDTH = 176
const COLUMN_WIDTH = 72
/** Slices of the record the density strip counts events in. */
const DENSITY_BUCKETS = 200

/**
 * A flowsheet: the chosen concepts in rows, the time window in columns, each
 * cell the aggregate of the concept's events in that column and how many there
 * were. The window pans and zooms by column, and syncs with the board's
 * timelines and data overviews like they sync with each other.
 */
export function DataTableWidget({ widgetId, config: configProp, onConfigureConcepts }: DataTableWidgetProps) {
  const { t, i18n } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const visible = useTabVisible()
  const widget = usePatientChartStore((s) => s.widgets.find((w) => w.id === widgetId))
  const patientId = usePatientChartStore((s) => s.selectedPatientId[projectUid] ?? null)
  const config = (configProp ?? widget?.config ?? {}) as DataTableConfig
  const conceptIds = useMemo(() => (config.conceptIds ?? []).map(Number).filter(Number.isInteger), [config.conceptIds])
  const idsKey = conceptIds.join(',')
  const columns = Math.max(1, Math.min(60, Number(config.columns ?? DEFAULT_COLUMNS) || DEFAULT_COLUMNS))
  const aggregate = config.aggregate ?? 'mean'
  const showCounts = config.showCounts ?? true
  const syncTimeRange = config.syncTimeRange ?? false
  /** What the widget says of a read that did not answer: stopped, or why it failed. */
  const failure = (err: unknown) => {
    if (isQueryStopped(err)) return t('patient_data.datatable_stopped')
    console.warn('[patient-datatable] query failed', err)
    return t('patient_data.datatable_error', { message: formatApiError(err).summary ?? String(err) })
  }

  const tabId = widget?.tabId ?? ''
  const boardId = usePatientChartStore((s) => s.tabs.find((tb) => tb.id === tabId)?.patientDashboardId)
  const syncAcrossTabs = usePatientChartStore((s) => s.dashboards.find((d) => d.id === boardId)?.syncTimelinesAcrossTabs ?? false)
  const channel = syncChannel(tabId, boardId, syncAcrossTabs)
  const { scope, ready: scopeReady } = usePatientScope(projectUid, dataSourceId, schemaMapping)

  const [names, setNames] = useState<Map<number, { vocabulary?: string; name?: string }>>(new Map())
  const [held, setHeld] = useState<Map<string, Set<number>> | undefined>(undefined)
  // The record's span with the patient it is of: another patient's first
  // cells must not be read over the previous one's window.
  const [boundsOf, setBoundsOf] = useState<{ patientId: string; window: DataTableWindow | null } | null>(null)
  const boundsKnown = !!patientId && boundsOf?.patientId === patientId
  const bounds = boundsKnown ? boundsOf.window : null
  const [boundsError, setBoundsError] = useState<string | null>(null)
  const [cellsError, setCellsError] = useState<string | null>(null)
  const [view, setView] = useState<DataTableWindow | null>(null)
  const [density, setDensity] = useState<number[]>([])
  const [cells, setCells] = useState<Map<string, Cell>>(new Map())
  const [units, setUnits] = useState<Map<number, string>>(new Map())
  const [loading, setLoading] = useState(false)
  const [hover, setHover] = useState<Hover | null>(null)

  // The concepts' names and the tables that hold them: once per concept list.
  useEffect(() => {
    if (!dataSourceId || !schemaMapping || conceptIds.length === 0) return
    let cancelled = false
    void Promise.all([
      fetchConceptLabels(dataSourceId, schemaMapping, conceptIds).catch(() => new Map()),
      relationsHoldingConcepts(dataSourceId, schemaMapping, conceptIds).catch(() => undefined),
    ]).then(([labels, holding]) => {
      if (cancelled) return
      setNames(labels)
      setHeld(holding)
    })
    return () => { cancelled = true }
    // idsKey stands for conceptIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSourceId, schemaMapping, idsKey])

  // A different patient: the window goes back to the whole record, here and on
  // the channel (a peer's window would frame dates this patient has nothing at).
  const lastPatient = useRef(patientId)
  useEffect(() => {
    if (lastPatient.current === patientId) return
    lastPatient.current = patientId
    forgetTimelineRange(channel)
    setView(null)
    setCells(new Map())
    setDensity([])
    setCellsError(null)
  }, [patientId, channel])

  // The record's span for these concepts: what the table opens on.
  useEffect(() => {
    if (!visible || !scopeReady || !dataSourceId || !schemaMapping || !patientId || conceptIds.length === 0) return
    const sql = buildDataTableBoundsQuery(schemaMapping, conceptIds, patientId, scope, { held })
    setBoundsError(null)
    if (!sql) {
      setBoundsOf({ patientId, window: null })
      return
    }
    const controller = new AbortController()
    patientQuery(dataSourceId, sql, { signal: controller.signal, origin: 'Data table · first and last event of the concepts' })
      .then(([row]) => {
        const lo = toMs(row?.first_event)
        const hi = toMs(row?.last_event)
        setBoundsOf({ patientId, window: lo != null && hi != null ? { lo, hi: hi + 1 } : null })
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setBoundsOf({ patientId, window: null })
        setBoundsError(failure(err))
      })
    return () => controller.abort()
    // idsKey stands for conceptIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, scopeReady, dataSourceId, schemaMapping, patientId, idsKey, scope, held])

  // The density strip: counts per slice of the whole record, once per record.
  useEffect(() => {
    if (!visible || !scopeReady || !dataSourceId || !schemaMapping || !patientId || !bounds) return
    const from = isoOrNull(bounds.lo)
    const to = isoOrNull(bounds.hi)
    const sql = from && to
      ? buildDataTableDensityQuery(schemaMapping, conceptIds, patientId, scope, { from, to, buckets: DENSITY_BUCKETS, held })
      : null
    if (!sql) return
    const controller = new AbortController()
    patientQuery(dataSourceId, sql, { signal: controller.signal, origin: 'Data table · density strip of the record' })
      .then((rows) => {
        const counts = new Array<number>(DENSITY_BUCKETS).fill(0)
        for (const r of rows) {
          const b = Number(r.col)
          if (b >= 0 && b < DENSITY_BUCKETS) counts[b] += Number(r.n ?? 0)
        }
        setDensity(counts)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        // Navigation aid, not data: the table still shows without it.
        console.warn('[patient-datatable] density query failed', err)
        setDensity([])
      })
    return () => controller.abort()
    // idsKey stands for conceptIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, scopeReady, dataSourceId, schemaMapping, patientId, bounds, idsKey, scope, held])

  // Synced: the channel's window first, then whatever a peer moves to.
  useEffect(() => {
    if (!syncTimeRange || !tabId) return
    const current = getTimelineRange(channel)
    if (current) setView({ lo: current.min, hi: current.max ?? current.min })
    return subscribeTimelineSync(channel, (range, sourceId) => {
      if (sourceId === widgetId) return
      setView(range ? { lo: range.min, hi: range.max ?? range.min } : null)
    })
  }, [syncTimeRange, tabId, channel, widgetId])

  const shown = view ?? bounds
  const move = useCallback((next: DataTableWindow | null) => {
    setView(next)
    if (syncTimeRange) broadcastTimelineRange(channel, widgetId, next ? { min: next.lo, max: next.hi } : null)
  }, [syncTimeRange, channel, widgetId])

  // The cells of the window: the database aggregates, one row per (concept, column).
  useEffect(() => {
    if (!visible || !scopeReady || !dataSourceId || !schemaMapping || !patientId || !shown || conceptIds.length === 0) return
    const from = isoOrNull(shown.lo)
    const to = isoOrNull(shown.hi)
    const sql = from && to
      ? buildDataTableQuery(schemaMapping, conceptIds, patientId, scope, { from, to, columns, aggregate, held })
      : null
    if (!sql) {
      setCells(new Map())
      return
    }
    const controller = new AbortController()
    setLoading(true)
    // A drag of the window through several columns reads once it settles.
    const timer = setTimeout(() => {
      patientQuery(dataSourceId, sql, { signal: controller.signal, origin: `Data table · ${aggregate} of each concept in ${columns} columns` })
        .then((rows) => {
          const next = new Map<string, Cell>()
          const unitOf = new Map<number, string>()
          for (const r of rows) {
            const concept = Number(r.concept_id)
            next.set(`${concept}|${Number(r.col)}`, {
              value: r.value == null ? null : Number(r.value),
              text: r.text == null ? null : String(r.text),
              n: Number(r.n ?? 0),
            })
            if (r.unit != null && !unitOf.has(concept)) unitOf.set(concept, String(r.unit))
          }
          setCells(next)
          setUnits(unitOf)
          setCellsError(null)
        })
        .catch((err) => {
          if (controller.signal.aborted) return
          setCells(new Map())
          setCellsError(failure(err))
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 150)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // idsKey stands for conceptIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, scopeReady, dataSourceId, schemaMapping, patientId, shown, idsKey, columns, aggregate, scope, held])

  const cols = shown ? columnsOf(shown, columns) : []
  const width = shown ? (shown.hi - shown.lo) / columns : 0
  const nameOf = (id: number) => names.get(id)?.name ?? String(id)

  let message: string | null = null
  if (conceptIds.length === 0) message = t('patient_data.configure_concepts')
  else if (!patientId) message = t('patient_data.select_patient_first')
  else if (!shown) message = !boundsKnown ? t('common.loading') : boundsError ?? t('patient_data.no_data')

  if (message) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className={boundsError && message === boundsError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{message}</p>
        {conceptIds.length === 0 && onConfigureConcepts && (
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={onConfigureConcepts}>
            <Settings2 size={12} />
            {t('patient_data.configure_widget')}
          </Button>
        )}
      </div>
    )
  }

  const hovered = hover ? cells.get(`${hover.concept}|${hover.col}`) : undefined
  return (
    <div className="flex h-full flex-col overflow-hidden" aria-busy={loading}>
      {cellsError && <p role="alert" className="shrink-0 border-b px-2 py-1 text-[10px] text-destructive">{cellsError}</p>}
      <div className={loading ? 'min-h-0 flex-1 overflow-auto opacity-60' : 'min-h-0 flex-1 overflow-auto'}>
        {/* Columns keep a readable width: a narrow widget scrolls rather than
            cutting every value to an ellipsis. */}
        <Table className="table-fixed" style={{ minWidth: NAME_WIDTH + cols.length * COLUMN_WIDTH }}>
          <TableHeader className="sticky top-0 z-10 bg-muted">
            <TableRow>
              <TableHead className="sticky left-0 z-20 select-none overflow-hidden bg-muted text-xs" style={{ width: NAME_WIDTH }}>
                {t('patient_data.datatable_concept')}
              </TableHead>
              {cols.map((c) => (
                <TableHead key={c.index} className="relative select-none overflow-hidden whitespace-normal py-1 text-right text-xs leading-tight tabular-nums">
                  {columnStartLabel(c.lo, width, i18n.language)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {conceptIds.map((id) => (
              <TableRow key={id}>
                <TableCell className="sticky left-0 z-[5] overflow-hidden truncate bg-background px-2 py-1 text-xs">
                  {nameOf(id)}
                  {units.get(id) && <span className="ml-1 text-[10px] text-muted-foreground">{units.get(id)}</span>}
                </TableCell>
                {cols.map((c) => {
                  const cell = cells.get(`${id}|${c.index}`)
                  return (
                    <TableCell
                      key={c.index}
                      className="overflow-hidden truncate px-2 py-1 text-right text-xs tabular-nums"
                      onMouseEnter={(e) => cell && setHover({ x: e.clientX, y: e.clientY, concept: id, col: c.index })}
                      onMouseMove={(e) => cell && setHover({ x: e.clientX, y: e.clientY, concept: id, col: c.index })}
                      onMouseLeave={() => setHover(null)}
                    >
                      {cell ? (
                        <>
                          {formatCell(cell, aggregate, i18n.language)}
                          {showCounts && <sub className="ml-0.5 text-[10px] text-muted-foreground">{cell.n}</sub>}
                        </>
                      ) : (
                        <span className="text-muted-foreground/50">·</span>
                      )}
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {bounds && (
        <div className="flex shrink-0">
          {/* What a cell holds, beside the strip that sets the columns. */}
          <div className="flex shrink-0 flex-col justify-center border-t px-2 text-[10px] leading-tight text-muted-foreground" style={{ width: NAME_WIDTH }}>
            <span>{t(`patient_data.datatable_aggregate_${aggregate}`)}</span>
            <span>{t('patient_data.datatable_column_width', { width: durationLabel(width, i18n.language, (unit, value) => t(`patient_data.datatable_duration_${unit}`, { value })) })}</span>
          </div>
          <div className="min-w-0 flex-1 pr-2">
            <DataTableRangeStrip bounds={bounds} view={shown ?? bounds} counts={density} onViewChange={move} />
          </div>
        </div>
      )}
      <FloatingChartTooltip point={hover && hovered ? { x: hover.x, y: hover.y } : null}>
        {hover && hovered && (
          <ChartTooltipCard
            title={nameOf(hover.concept)}
            rows={[
              { label: t(`patient_data.datatable_aggregate_${aggregate}`), value: formatCell(hovered, aggregate, i18n.language) },
              { label: t('patient_data.datatable_events'), value: hovered.n.toLocaleString(i18n.language) },
              { label: t('patient_data.datatable_period'), value: periodLabel(cols[hover.col]?.lo ?? 0, cols[hover.col]?.hi ?? 0, width, i18n.language) },
            ]}
          />
        )}
      </FloatingChartTooltip>
    </div>
  )
}
