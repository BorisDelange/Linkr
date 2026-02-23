import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { User, Calendar, Bed, Heart, HeartOff, List, GanttChart, ZoomIn, ZoomOut, Maximize2, ExternalLink } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip'
import { usePatientChartContext } from '../PatientChartContext'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  buildPatientSummaryQuery,
  buildPatientVisitSummaryQuery,
} from '@/lib/duckdb/patient-data-queries'

interface SummaryRow {
  patient_id: string
  gender?: string
  death_date?: string
  first_visit_start?: string
  last_visit_start?: string
  age_first_visit?: number
  age_last_visit?: number
  visit_count?: number
  visit_detail_count?: number
}

interface VisitRow {
  row_type: 'visit' | 'visit_detail'
  visit_id?: string
  visit_detail_id?: string
  start_date?: string
  end_date?: string
  visit_type?: string
  unit?: string
  los_days?: number
}

function daysBetween(start?: string, end?: string): number | null {
  if (!start || !end) return null
  try {
    const ms = new Date(end).getTime() - new Date(start).getTime()
    return Math.round(ms / (1000 * 60 * 60 * 24))
  } catch {
    return null
  }
}

/** Format an interval in days as a compact human-readable string. */
function formatInterval(days: number): string {
  if (days < 30) return `${days}d`
  const months = days / 30.44
  if (months < 24) return `${months.toFixed(1)} m`
  const years = days / 365.25
  return `${years.toFixed(1)} y`
}

// ---------------------------------------------------------------------------
// Chart color helpers
// ---------------------------------------------------------------------------

const CHART_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
]

function resolveColor(cssVar: string): string {
  if (typeof document === 'undefined') return '#888'
  const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar.slice(4, -1)).trim()
  return raw || '#888'
}

// ---------------------------------------------------------------------------
// Gantt Timeline Component (SVG)
// ---------------------------------------------------------------------------

interface GanttBar {
  visitId: string
  visitDetailId?: string
  start: number // timestamp
  end: number
  color: string
  tooltipTitle: string
  tooltipDetails: string[]
}

interface GanttLane {
  label: string
  bars: GanttBar[]
}

interface GanttTimelineProps {
  visitRows: VisitRow[]
  detailsByVisit: Map<string, VisitRow[]>
  formatDateTime: (d: string | undefined) => string
  lang: string
  t: (key: string, opts?: Record<string, unknown>) => string
  onNavigate?: (visitId: string, visitDetailId?: string) => void
}

const ROW_HEIGHT = 22
const LABEL_WIDTH = 100
const AXIS_HEIGHT = 28
const TOP_PAD = 4

function GanttTimeline({ visitRows, detailsByVisit, formatDateTime, lang, t, onNavigate }: GanttTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(400)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; details: string[] } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visitId: string; visitDetailId?: string } | null>(null)
  const [labelTooltip, setLabelTooltip] = useState<{ x: number; y: number; text: string } | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width)
    })
    obs.observe(containerRef.current)
    setWidth(containerRef.current.clientWidth)
    return () => obs.disconnect()
  }, [])

  // Build lanes: group bars by label (unit name or visit type)
  const { lanes, globalMin, globalMax } = useMemo(() => {
    const laneMap = new Map<string, GanttBar[]>()
    const laneOrder: string[] = []
    let gMin = Infinity
    let gMax = -Infinity

    function addBar(label: string, bar: GanttBar) {
      if (!laneMap.has(label)) {
        laneMap.set(label, [])
        laneOrder.push(label)
      }
      laneMap.get(label)!.push(bar)
    }

    visitRows.forEach((v, vi) => {
      const vDetails = detailsByVisit.get(String(v.visit_id)) ?? []
      const color = CHART_COLORS[vi % CHART_COLORS.length]

      if (vDetails.length > 0) {
        for (const d of vDetails) {
          if (!d.start_date) continue
          const s = new Date(d.start_date).getTime()
          const e = d.end_date ? new Date(d.end_date).getTime() : s + 86400000
          gMin = Math.min(gMin, s)
          gMax = Math.max(gMax, e)
          const losDays = d.los_days != null ? d.los_days : ((e - s) / 86400000)
          const sameDateTime = d.start_date === d.end_date || (!d.end_date)
          const tipDetails: string[] = [formatDateTime(d.start_date)]
          if (!sameDateTime) {
            tipDetails.push(formatDateTime(d.end_date))
            tipDetails.push(`${losDays.toFixed(1)} ${t('patient_data.days_unit')}`)
          }
          const rawUnit = d.unit ? d.unit.split('|')[0].trim() : null
          const label = rawUnit || `Visit ${vi + 1}`
          addBar(label, {
            visitId: String(v.visit_id),
            visitDetailId: d.visit_detail_id ? String(d.visit_detail_id) : undefined,
            start: s,
            end: e,
            color,
            tooltipTitle: label,
            tooltipDetails: tipDetails,
          })
        }
      } else {
        if (!v.start_date) return
        const s = new Date(v.start_date).getTime()
        const e = v.end_date ? new Date(v.end_date).getTime() : s + 86400000
        gMin = Math.min(gMin, s)
        gMax = Math.max(gMax, e)
        const losMs = e - s
        const losDisplay = (losMs / 86400000).toFixed(1)
        const sameDateTime = v.start_date === v.end_date || (!v.end_date)
        const tipDetails: string[] = [formatDateTime(v.start_date)]
        if (!sameDateTime) {
          tipDetails.push(formatDateTime(v.end_date))
          tipDetails.push(`${losDisplay} ${t('patient_data.days_unit')}`)
        }
        const label = v.visit_type || `Visit ${vi + 1}`
        addBar(label, {
          visitId: String(v.visit_id),
          start: s,
          end: e,
          color,
          tooltipTitle: label,
          tooltipDetails: tipDetails,
        })
      }
    })

    const result: GanttLane[] = laneOrder.map((label) => ({
      label,
      bars: laneMap.get(label)!,
    }))

    // Add small padding to the range (5% on each side)
    const range = gMax - gMin || 86400000
    return {
      lanes: result,
      globalMin: gMin - range * 0.05,
      globalMax: gMax + range * 0.05,
    }
  }, [visitRows, detailsByVisit, formatDateTime, t])

  // Zoom/pan state
  const [xRange, setXRange] = useState<[number, number]>([globalMin, globalMax])
  // Brush selection state (pixel X within chart area)
  const [brushStart, setBrushStart] = useState<number | null>(null)
  const [brushEnd, setBrushEnd] = useState<number | null>(null)
  const isDragging = useRef(false)

  // Reset range when data changes
  useEffect(() => {
    setXRange([globalMin, globalMax])
  }, [globalMin, globalMax])

  const chartWidth = Math.max(50, width - LABEL_WIDTH)
  const svgHeight = lanes.length * ROW_HEIGHT + AXIS_HEIGHT + TOP_PAD

  const xToPixel = useCallback(
    (ts: number) => ((ts - xRange[0]) / (xRange[1] - xRange[0])) * chartWidth,
    [xRange, chartWidth],
  )

  const pixelToX = useCallback(
    (px: number) => xRange[0] + (px / chartWidth) * (xRange[1] - xRange[0]),
    [xRange, chartWidth],
  )

  // Zoom in/out buttons
  const handleZoomIn = useCallback(() => {
    const [min, max] = xRange
    const range = max - min
    const shrink = range * 0.2
    setXRange([min + shrink, max - shrink])
  }, [xRange])

  const handleZoomOut = useCallback(() => {
    const [min, max] = xRange
    const range = max - min
    const grow = range * 0.25
    setXRange([min - grow, max + grow])
  }, [xRange])

  const handleReset = useCallback(() => {
    setXRange([globalMin, globalMax])
  }, [globalMin, globalMax])

  // Brush selection: drag to zoom into a time range
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (e.button !== 0) return
      const rect = e.currentTarget.getBoundingClientRect()
      const px = e.clientX - rect.left - LABEL_WIDTH
      if (px < 0 || px > chartWidth) return
      isDragging.current = true
      setBrushStart(px)
      setBrushEnd(px)
    },
    [chartWidth],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!isDragging.current || brushStart === null) return
      const rect = e.currentTarget.getBoundingClientRect()
      const px = Math.max(0, Math.min(chartWidth, e.clientX - rect.left - LABEL_WIDTH))
      setBrushEnd(px)
    },
    [brushStart, chartWidth],
  )

  const handleMouseUp = useCallback(() => {
    if (isDragging.current && brushStart !== null && brushEnd !== null) {
      const minPx = Math.min(brushStart, brushEnd)
      const maxPx = Math.max(brushStart, brushEnd)
      // Only zoom if brush is wide enough (> 5px)
      if (maxPx - minPx > 5) {
        const newMin = pixelToX(minPx)
        const newMax = pixelToX(maxPx)
        setXRange([newMin, newMax])
      }
    }
    isDragging.current = false
    setBrushStart(null)
    setBrushEnd(null)
  }, [brushStart, brushEnd, pixelToX])

  // Generate axis ticks
  const ticks = useMemo(() => {
    const [min, max] = xRange
    const range = max - min
    const targetTicks = Math.max(2, Math.floor(chartWidth / 80))
    const step = range / targetTicks
    const result: { ts: number; label: string }[] = []
    for (let i = 0; i <= targetTicks; i++) {
      const ts = min + step * i
      const d = new Date(ts)
      const locale = lang === 'fr' ? 'fr-FR' : 'en-US'
      const label = range > 365 * 86400000
        ? d.toLocaleDateString(locale, { year: 'numeric', month: '2-digit' })
        : d.toLocaleDateString(locale, { month: '2-digit', day: '2-digit' })
      result.push({ ts, label })
    }
    return result
  }, [xRange, chartWidth])

  if (lanes.length === 0) return null

  return (
    <div ref={containerRef} className="relative w-full select-none">
      {/* Zoom controls */}
      <div className="absolute top-0 right-0 z-10 flex items-center gap-0.5 p-0.5">
        <Button variant="ghost" size="icon-xs" className="h-5 w-5" onClick={handleZoomIn}>
          <ZoomIn size={10} />
        </Button>
        <Button variant="ghost" size="icon-xs" className="h-5 w-5" onClick={handleZoomOut}>
          <ZoomOut size={10} />
        </Button>
        <Button variant="ghost" size="icon-xs" className="h-5 w-5" onClick={handleReset}>
          <Maximize2 size={10} />
        </Button>
      </div>

      <svg
        width={width}
        height={svgHeight}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { handleMouseUp(); setTooltip(null) }}
        onDoubleClick={handleReset}
        style={{ cursor: 'crosshair' }}
      >
        {/* Lane labels with styled tooltip on hover */}
        {lanes.map((lane, i) => (
          <text
            key={`label-${i}`}
            x={LABEL_WIDTH - 4}
            y={TOP_PAD + i * ROW_HEIGHT + ROW_HEIGHT / 2 + 3}
            textAnchor="end"
            className="fill-muted-foreground"
            fontSize={9}
            style={{ cursor: 'default' }}
            onMouseEnter={(e) => {
              setLabelTooltip({ x: e.clientX, y: e.clientY - 8, text: lane.label })
            }}
            onMouseLeave={() => setLabelTooltip(null)}
          >
            {lane.label.length > 14 ? lane.label.slice(0, 13) + '…' : lane.label}
          </text>
        ))}

        {/* Chart area */}
        <g transform={`translate(${LABEL_WIDTH}, 0)`}>
          {/* Row backgrounds */}
          {lanes.map((_, i) => (
            <rect
              key={`bg-${i}`}
              x={0}
              y={TOP_PAD + i * ROW_HEIGHT}
              width={chartWidth}
              height={ROW_HEIGHT}
              className={i % 2 === 0 ? 'fill-muted/30' : 'fill-transparent'}
            />
          ))}

          {/* Bars — multiple bars per lane */}
          {lanes.map((lane, laneIdx) =>
            lane.bars.map((bar, barIdx) => {
              const x1 = Math.max(0, xToPixel(bar.start))
              const x2 = Math.min(chartWidth, xToPixel(bar.end))
              if (x2 <= 0 || x1 >= chartWidth) return null
              return (
                <rect
                  key={`bar-${laneIdx}-${barIdx}`}
                  x={x1}
                  y={TOP_PAD + laneIdx * ROW_HEIGHT + 3}
                  width={Math.max(2, x2 - x1)}
                  height={ROW_HEIGHT - 6}
                  rx={3}
                  fill={resolveColor(bar.color)}
                  opacity={0.85}
                  onMouseEnter={(e) => {
                    setTooltip({
                      x: e.clientX,
                      y: e.clientY - 8,
                      title: bar.tooltipTitle,
                      details: bar.tooltipDetails,
                    })
                  }}
                  onMouseLeave={() => setTooltip(null)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setTooltip(null)
                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      visitId: bar.visitId,
                      visitDetailId: bar.visitDetailId,
                    })
                  }}
                />
              )
            }),
          )}

          {/* Axis line */}
          <line
            x1={0}
            y1={TOP_PAD + lanes.length * ROW_HEIGHT}
            x2={chartWidth}
            y2={TOP_PAD + lanes.length * ROW_HEIGHT}
            className="stroke-border"
            strokeWidth={1}
          />

          {/* Axis ticks */}
          {ticks.map((tick, i) => {
            const x = xToPixel(tick.ts)
            if (x < 0 || x > chartWidth) return null
            return (
              <g key={`tick-${i}`}>
                <line
                  x1={x}
                  y1={TOP_PAD + lanes.length * ROW_HEIGHT}
                  x2={x}
                  y2={TOP_PAD + lanes.length * ROW_HEIGHT + 4}
                  className="stroke-muted-foreground"
                  strokeWidth={0.5}
                />
                <text
                  x={x}
                  y={TOP_PAD + lanes.length * ROW_HEIGHT + 16}
                  textAnchor="middle"
                  className="fill-muted-foreground"
                  fontSize={8}
                >
                  {tick.label}
                </text>
              </g>
            )
          })}
        </g>

        {/* Brush selection overlay */}
        {brushStart !== null && brushEnd !== null && Math.abs(brushEnd - brushStart) > 2 && (
          <rect
            x={LABEL_WIDTH + Math.min(brushStart, brushEnd)}
            y={TOP_PAD}
            width={Math.abs(brushEnd - brushStart)}
            height={lanes.length * ROW_HEIGHT}
            className="fill-primary/15 stroke-primary"
            strokeWidth={1}
            strokeDasharray="3,2"
            pointerEvents="none"
          />
        )}
      </svg>

      {/* Bar tooltip via portal */}
      {tooltip && createPortal(
        <div
          className="fixed z-[9999] pointer-events-none rounded-md bg-foreground/90 px-2.5 py-1.5 text-background shadow-lg"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <div className="text-[10px] font-semibold leading-tight whitespace-nowrap mb-0.5">
            {tooltip.title}
          </div>
          {tooltip.details.map((line, i) => (
            <div key={i} className="text-[10px] leading-tight whitespace-nowrap flex items-center gap-1">
              <span className="text-background/50">&#8226;</span>
              {line}
            </div>
          ))}
        </div>,
        document.body,
      )}

      {/* Y-axis label tooltip via portal */}
      {labelTooltip && createPortal(
        <div
          className="fixed z-[9999] pointer-events-none rounded-md bg-foreground/90 px-2 py-1 text-background shadow-lg"
          style={{
            left: labelTooltip.x,
            top: labelTooltip.y,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <div className="text-[10px] font-medium leading-tight whitespace-nowrap">
            {labelTooltip.text}
          </div>
        </div>,
        document.body,
      )}

      {/* Context menu via portal */}
      {contextMenu && onNavigate && createPortal(
        <>
          {/* Backdrop to dismiss */}
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null) }}
          />
          <div
            className="fixed z-[9999] rounded-md border bg-popover py-1 shadow-md"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-left"
              onClick={() => {
                onNavigate(contextMenu.visitId, contextMenu.visitDetailId)
                setContextMenu(null)
              }}
            >
              <ExternalLink size={11} className="text-muted-foreground" />
              {t('patient_data.go_to_unit_stay')}
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Text View with vertical timeline
// ---------------------------------------------------------------------------

interface TextTimelineProps {
  visitRows: VisitRow[]
  detailsByVisit: Map<string, VisitRow[]>
  formatDate: (d: string | undefined) => string
  formatDateShort: (d: string | undefined) => string
  t: (key: string, opts?: Record<string, unknown>) => string
  onNavigate?: (visitId: string, visitDetailId?: string) => void
}

function TextTimeline({ visitRows, detailsByVisit, formatDate, formatDateShort, t, onNavigate }: TextTimelineProps) {
  return (
    <div className="pr-2 pb-1">
      {visitRows.map((v, idx) => {
        const los = v.los_days ?? daysBetween(v.start_date, v.end_date)
        const details = detailsByVisit.get(String(v.visit_id)) ?? []
        const isLast = idx === visitRows.length - 1

        // Compute interval to next visit
        let intervalDays: number | null = null
        if (!isLast) {
          const nextVisit = visitRows[idx + 1]
          intervalDays = daysBetween(v.end_date ?? v.start_date, nextVisit.start_date)
        }

        return (
          <div key={v.visit_id}>
            {/* Visit row with timeline node */}
            <div className="flex items-stretch">
              {/* Vertical line + node */}
              <div className="flex flex-col items-center w-4 shrink-0">
                <div className="w-px flex-1 bg-muted-foreground/30" />
                <div className="w-2 h-2 rounded-full bg-muted-foreground/60 shrink-0" />
                <div className={`w-px flex-1 ${isLast && !intervalDays ? 'bg-transparent' : 'bg-muted-foreground/30'}`} />
              </div>

              {/* Navigate icon */}
              {onNavigate && (
                <button
                  className="flex items-center justify-center w-4 shrink-0 self-center text-muted-foreground/50 hover:text-primary transition-colors"
                  onClick={() => onNavigate(String(v.visit_id))}
                  title={t('patient_data.go_to_hospitalization')}
                >
                  <ExternalLink size={9} />
                </button>
              )}

              {/* Content */}
              <div className="flex-1 min-w-0 py-0.5 pl-1">
                <div className="flex items-start gap-1.5 text-xs">
                  <Calendar size={10} className="shrink-0 text-muted-foreground mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1 flex-wrap">
                      <span className="font-medium">
                        {formatDate(v.start_date)}
                      </span>
                      {v.end_date && (
                        <>
                          <span className="text-muted-foreground">—</span>
                          <span className="font-medium">{formatDate(v.end_date)}</span>
                        </>
                      )}
                      {los != null && (
                        <span className="text-muted-foreground">
                          ({t('patient_data.days_short', { count: los })})
                        </span>
                      )}
                      {v.visit_type && (
                        <span className="text-muted-foreground ml-auto shrink-0">
                          {v.visit_type}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {/* Visit detail rows (unit stays) */}
                {details.map((d) => {
                  const dLos = d.los_days ?? daysBetween(d.start_date, d.end_date)
                  return (
                    <div
                      key={d.visit_detail_id}
                      className="flex items-start gap-1.5 text-xs ml-4 mt-0.5"
                    >
                      {onNavigate && d.visit_detail_id ? (
                        <button
                          className="shrink-0 mt-0.5 text-muted-foreground/50 hover:text-primary transition-colors"
                          onClick={() => onNavigate(String(v.visit_id), String(d.visit_detail_id))}
                          title={t('patient_data.go_to_unit_stay')}
                        >
                          <Bed size={9} />
                        </button>
                      ) : (
                        <Bed size={9} className="shrink-0 text-muted-foreground mt-0.5" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1 flex-wrap">
                          {d.unit && (
                            <span className="font-medium text-muted-foreground">
                              {d.unit.split('|')[0].trim()}
                            </span>
                          )}
                          <span className="text-muted-foreground">
                            {formatDateShort(d.start_date)}
                            {d.end_date ? ` — ${formatDateShort(d.end_date)}` : ''}
                          </span>
                          {dLos != null && (
                            <span className="text-muted-foreground">
                              ({t('patient_data.days_short', { count: dLos })})
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Interval between visits */}
            {intervalDays != null && intervalDays > 0 && (
              <div className="flex items-stretch">
                <div className="flex flex-col items-center w-4 shrink-0">
                  <div className="w-px flex-1 bg-muted-foreground/30" />
                </div>
                <div className="pl-1.5 py-1">
                  <span className="text-[9px] text-muted-foreground/70 font-medium italic">
                    {formatInterval(intervalDays)}
                  </span>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Widget
// ---------------------------------------------------------------------------

export function PatientSummaryWidget() {
  const { t, i18n } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const { selectedPatientId, setSelectedVisit, setSelectedVisitDetail } = usePatientChartStore()
  const patientId = selectedPatientId[projectUid] ?? null
  const [summary, setSummary] = useState<SummaryRow | null>(null)
  const [visits, setVisits] = useState<VisitRow[]>([])
  const [viewMode, setViewMode] = useState<'text' | 'timeline'>('timeline')

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || !patientId) {
      setSummary(null)
      setVisits([])
      return
    }
    let cancelled = false

    // Fetch summary
    const summSql = buildPatientSummaryQuery(schemaMapping, patientId)
    if (summSql) {
      queryDataSource(dataSourceId, summSql)
        .then((rows) => {
          if (!cancelled && rows.length > 0) setSummary(rows[0] as SummaryRow)
        })
        .catch(() => {
          if (!cancelled) setSummary(null)
        })
    }

    // Fetch visit list
    const visitSql = buildPatientVisitSummaryQuery(schemaMapping, patientId)
    if (visitSql) {
      console.log('[PatientSummary] visitSql:', visitSql)
      queryDataSource(dataSourceId, visitSql)
        .then((rows) => {
          console.log('[PatientSummary] visit rows:', JSON.stringify(rows, null, 2))
          if (!cancelled) setVisits(rows as VisitRow[])
        })
        .catch(() => {
          if (!cancelled) setVisits([])
        })
    }

    return () => {
      cancelled = true
    }
  }, [dataSourceId, schemaMapping, patientId])

  const gv = schemaMapping?.genderValues
  const formatGender = (g: string | undefined) => {
    if (!g || !gv) return g ?? '—'
    if (g === gv.male) return t('patient_data.male')
    if (g === gv.female) return t('patient_data.female')
    return g
  }

  const formatDate = useCallback((d: string | undefined) => {
    if (!d) return '—'
    try {
      const dt = new Date(d)
      if (i18n.language === 'fr') {
        return dt.toLocaleDateString('fr-FR', { year: 'numeric', month: '2-digit', day: '2-digit' })
      }
      const y = dt.getFullYear()
      const m = String(dt.getMonth() + 1).padStart(2, '0')
      const dd = String(dt.getDate()).padStart(2, '0')
      return `${y}-${m}-${dd}`
    } catch {
      return d
    }
  }, [i18n.language])

  const formatDateShort = useCallback((d: string | undefined) => {
    if (!d) return '—'
    try {
      const dt = new Date(d)
      if (i18n.language === 'fr') {
        return dt.toLocaleDateString('fr-FR', { month: '2-digit', day: '2-digit' })
      }
      const m = String(dt.getMonth() + 1).padStart(2, '0')
      const dd = String(dt.getDate()).padStart(2, '0')
      return `${m}-${dd}`
    } catch {
      return d
    }
  }, [i18n.language])

  const handleNavigateToStay = useCallback((visitId: string, visitDetailId?: string) => {
    setSelectedVisit(projectUid, visitId)
    if (visitDetailId) {
      // Small delay so the visit selection triggers the visit_detail list to load
      setTimeout(() => setSelectedVisitDetail(projectUid, visitDetailId), 50)
    }
  }, [projectUid, setSelectedVisit, setSelectedVisitDetail])

  const formatDateTime = useCallback((d: string | undefined) => {
    if (!d) return '—'
    try {
      const dt = new Date(d)
      const y = dt.getFullYear()
      const mo = String(dt.getMonth() + 1).padStart(2, '0')
      const dd = String(dt.getDate()).padStart(2, '0')
      const hh = String(dt.getHours()).padStart(2, '0')
      const mm = String(dt.getMinutes()).padStart(2, '0')
      if (i18n.language === 'fr') {
        return `${dd}/${mo}/${y} ${hh}:${mm}`
      }
      return `${y}/${mo}/${dd} ${hh}:${mm}`
    } catch {
      return d
    }
  }, [i18n.language])

  if (!patientId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">
          {t('patient_data.select_patient_first')}
        </p>
      </div>
    )
  }

  if (!summary) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
  }

  const isDead = !!summary.death_date
  const visitCount = summary.visit_count ?? 0
  const visitDetailCount = summary.visit_detail_count ?? 0

  // Group visit_detail rows under their parent visit
  const visitRows = visits.filter((r) => r.row_type === 'visit')
  const detailsByVisit = new Map<string, VisitRow[]>()
  for (const r of visits) {
    if (r.row_type === 'visit_detail' && r.visit_id) {
      const arr = detailsByVisit.get(String(r.visit_id)) ?? []
      arr.push(r)
      detailsByVisit.set(String(r.visit_id), arr)
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden">
      {/* Patient ID header */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10">
          <User size={13} className="text-violet-500" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold font-mono truncate">{summary.patient_id}</p>
        </div>
      </div>

      {/* Stats row: Gender, Age first, Age last */}
      <div className="grid grid-cols-3 gap-1.5 shrink-0">
        <div className="rounded-md bg-muted/50 px-2 py-1">
          <p className="text-[9px] text-muted-foreground leading-tight">{t('patient_data.gender_label')}</p>
          <p className="text-xs font-semibold">
            {formatGender(summary.gender != null ? String(summary.gender) : undefined)}
          </p>
        </div>
        <div className="rounded-md bg-muted/50 px-2 py-1">
          <p className="text-[9px] text-muted-foreground leading-tight">{t('patient_data.age_first_visit')}</p>
          <p className="text-xs font-semibold">
            {summary.age_first_visit != null
              ? `${Math.round(Number(summary.age_first_visit))} ${t('patient_data.years')}`
              : '—'}
          </p>
        </div>
        <div className="rounded-md bg-muted/50 px-2 py-1">
          <p className="text-[9px] text-muted-foreground leading-tight">{t('patient_data.age_last_visit')}</p>
          <p className="text-xs font-semibold">
            {summary.age_last_visit != null
              ? `${Math.round(Number(summary.age_last_visit))} ${t('patient_data.years')}`
              : '—'}
          </p>
        </div>
      </div>

      {/* Summary row: Death, Hospitalizations, Unit stays */}
      <div className="grid grid-cols-3 gap-1.5 shrink-0">
        <div className="rounded-md bg-muted/50 px-2 py-1">
          <p className="text-[9px] text-muted-foreground leading-tight">{t('patient_data.death')}</p>
          <div className="flex items-center gap-1">
            {isDead ? (
              <HeartOff size={10} className="text-red-500 shrink-0" />
            ) : (
              <Heart size={10} className="text-green-500 shrink-0" />
            )}
            <p className="text-xs font-semibold">
              {isDead
                ? formatDate(summary.death_date)
                : t('patient_data.death_no')}
            </p>
          </div>
        </div>
        <div className="rounded-md bg-muted/50 px-2 py-1">
          <p className="text-[9px] text-muted-foreground leading-tight">{t('patient_data.visit_count')}</p>
          <p className="text-xs font-semibold">{visitCount}</p>
        </div>
        {visitDetailCount > 0 && (
          <div className="rounded-md bg-muted/50 px-2 py-1">
            <p className="text-[9px] text-muted-foreground leading-tight">{t('patient_data.unit_stays')}</p>
            <p className="text-xs font-semibold">{visitDetailCount}</p>
          </div>
        )}
      </div>

      {/* Hospitalization list */}
      {visitRows.length > 0 && (
        <div className="flex flex-col min-h-0 flex-1 overflow-hidden">
          {/* Header with toggle */}
          <div className="flex items-center gap-1 shrink-0 mb-1">
            <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('patient_data.hospitalizations_list')}
            </h4>
            <div className="ml-auto flex items-center">
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={viewMode === 'timeline' ? 'secondary' : 'ghost'}
                      size="icon-xs"
                      className="h-5 w-5"
                      onClick={() => setViewMode('timeline')}
                    >
                      <GanttChart size={10} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t('patient_data.view_timeline')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={viewMode === 'text' ? 'secondary' : 'ghost'}
                      size="icon-xs"
                      className="h-5 w-5"
                      onClick={() => setViewMode('text')}
                    >
                      <List size={10} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t('patient_data.view_text')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            {viewMode === 'text' ? (
              <TextTimeline
                visitRows={visitRows}
                detailsByVisit={detailsByVisit}
                formatDate={formatDate}
                formatDateShort={formatDateShort}
                t={t}
                onNavigate={handleNavigateToStay}
              />
            ) : (
              <GanttTimeline
                visitRows={visitRows}
                detailsByVisit={detailsByVisit}
                formatDateTime={formatDateTime}
                lang={i18n.language}
                t={t}
                onNavigate={handleNavigateToStay}
              />
            )}
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
