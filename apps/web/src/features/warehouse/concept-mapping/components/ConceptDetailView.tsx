import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Code2 } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, LineChart, Line } from 'recharts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { BoxPlot } from '@/components/charts/box-plot'
import { niceTicks, tightHistogramScale } from '@/lib/chart-ticks'
import { cn } from '@/lib/utils'
import type { SourceConceptRow } from '../MappingEditorTab'

interface ConceptDetailViewProps {
  concept: SourceConceptRow
  onBack: () => void
}

const COLORS = ['#60a5fa', '#34d399', '#fb923c', '#f87171', '#a78bfa', '#fbbf24', '#38bdf8', '#4ade80']

const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: 'var(--color-popover)',
    border: '1px solid var(--color-border)',
    borderRadius: 6,
    fontSize: 12,
    color: 'var(--color-popover-foreground)',
  },
  itemStyle: { color: 'var(--color-popover-foreground)' },
  labelStyle: { color: 'var(--color-popover-foreground)' },
}

// "Start at zero" is a per-user preference shared by every numeric histogram widget,
// so it survives switching concepts. Persisted in localStorage, on by default.
const START_AT_ZERO_KEY = 'concept-mapping.histogram-start-at-zero'
const startAtZeroListeners = new Set<() => void>()

function getStartAtZero(): boolean {
  return localStorage.getItem(START_AT_ZERO_KEY) !== 'false'
}

function setStartAtZero(value: boolean): void {
  localStorage.setItem(START_AT_ZERO_KEY, String(value))
  startAtZeroListeners.forEach((fn) => fn())
}

function useStartAtZero(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      startAtZeroListeners.add(cb)
      return () => startAtZeroListeners.delete(cb)
    },
    getStartAtZero,
    () => true,
  )
  return [value, setStartAtZero]
}

export function ConceptDetailView({ concept, onBack }: ConceptDetailViewProps) {
  const { t } = useTranslation()
  const rawInfo = concept.info_json
  const info = (rawInfo && typeof rawInfo === 'object' && !Array.isArray(rawInfo)) ? rawInfo : null
  const [jsonModalOpen, setJsonModalOpen] = useState(false)

  const sections = info ? extractSections(info, t, concept) : []
  const textFields = info ? extractTextFields(info) : []

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <ArrowLeft size={16} />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold" title={concept.concept_name}>{concept.concept_name}</span>
            {concept.concept_code && (
              <Badge variant="outline" className="shrink-0 font-mono">
                {concept.concept_code}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {concept.terminology_name && <span>{concept.terminology_name}</span>}
            {concept.domain_id && <span>· {concept.domain_id}</span>}
            {concept.concept_class_id && <span>· {concept.concept_class_id}</span>}
          </div>
        </div>
        {info && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            title={t('concept_mapping.detail_raw_json')}
            onClick={() => setJsonModalOpen(true)}
          >
            <Code2 size={14} />
          </Button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <div className="space-y-4">
          {/* Sections — identity and volume lead, then the charts. */}
          {sections.map((section, i) => (
            <SectionRenderer key={i} section={section} />
          ))}

          {/* Whatever the profile carried that no block claimed. */}
          {textFields.length > 0 && (
            <Card className="p-3">
              <table className="w-full text-xs">
                <tbody>
                  {textFields.map((item) => (
                    <tr key={item.label}>
                      <td className="whitespace-nowrap pr-4 py-0.5 text-muted-foreground align-top">{item.label}</td>
                      <td className="py-0.5 font-medium" title={item.value}>{item.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {/* No info */}
          {!info && (
            <Card>
              <div className="flex flex-col items-center py-8">
                <p className="text-xs text-muted-foreground">{t('concept_mapping.detail_no_info')}</p>
              </div>
            </Card>
          )}

        </div>
      </div>

      {/* JSON modal */}
      <Dialog open={jsonModalOpen} onOpenChange={setJsonModalOpen}>
        <DialogContent className="flex max-h-[90vh] w-[90vw] sm:max-w-5xl flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Code2 size={14} />
              {t('concept_mapping.detail_raw_json')}
              {concept.concept_name && (
                <span className="truncate text-xs font-normal text-muted-foreground">— {concept.concept_name}</span>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
            <CodeEditor value={JSON.stringify(info, null, 2)} language="json" readOnly height="60vh" />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// --- Section types (exported for reuse in MappingDetailView) ---

export interface StatsSection {
  type: 'stats'
  title?: string
  items: { label: string; value: string; highlight?: boolean }[]
  boxplot?: { min: number; p25: number; median: number; p75: number; max: number; mean?: number }
}

export interface BarChartSection {
  type: 'bar'
  title: string
  data: { label: string; value: number }[]
  longLabels?: boolean
  /**
   * Lay the bars left-to-right, categories down the Y axis.
   *
   * For names rather than numbers — a ward is "Medical Intensive Care Unit",
   * which on a vertical axis has to be rotated and truncated to about a dozen
   * characters. Along Y it gets the full width of the panel.
   */
  horizontal?: boolean
  /** Append a unit to the value in the tooltip and along the axis. */
  valueSuffix?: string
}

export interface PieChartSection {
  type: 'pie'
  title: string
  data: { label: string; value: number }[]
}

export interface LineChartSection {
  type: 'line'
  title: string
  data: { label: string; value: number }[]
}

export interface TableSection {
  type: 'table'
  title: string
  rows: { label: string; value: string }[]
}

/**
 * A titled block of label/value pairs laid out in two columns.
 *
 * The identity and the per-patient summary are both read as a reference table
 * rather than scanned as a stats strip, and a single column of ten short rows
 * wastes the width the panel already has.
 */
export interface FieldsSection {
  type: 'fields'
  title: string
  rows: { label: string; value: string }[]
}

export interface ColumnsTableSection {
  type: 'columns_table'
  title: string
  columns: { key: string; label: string; align?: 'left' | 'right' }[]
  rows: Record<string, unknown>[]
}

export type Section = StatsSection | BarChartSection | PieChartSection | LineChartSection | TableSection | ColumnsTableSection | FieldsSection

function BarSection({ section }: { section: BarChartSection }) {
  const { t } = useTranslation()
  const [startAtZero, setStartAtZero] = useStartAtZero()

  const longLabels = section.longLabels || section.data.some((d) => d.label.length > 6)
  const bottomMargin = longLabels ? 70 : 25

  if (section.horizontal) {
    // Grow with the number of bars instead of squeezing them into a fixed box:
    // twenty wards in 200px are unreadable stripes.
    const height = Math.max(120, section.data.length * 26 + 30)
    const fmt = (v: number) =>
      `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}${section.valueSuffix ?? ''}`
    return (
      <SectionCard title={section.title}>
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={section.data} layout="vertical" margin={{ left: 5, right: 12, top: 2, bottom: 2 }}>
            <XAxis type="number" tick={{ fontSize: 10 }} domain={[0, 'auto']} tickFormatter={fmt} />
            <YAxis
              type="category"
              dataKey="label"
              tick={{ fontSize: 10 }}
              width={140}
              interval={0}
              tickFormatter={(v: string) => (v.length > 22 ? `${v.slice(0, 22)}…` : v)}
            />
            <Tooltip {...TOOLTIP_STYLE} cursor={{ fill: 'var(--color-accent)' }} formatter={(v) => fmt(Number(v))} />
            <Bar dataKey="value" fill="#60a5fa" radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </SectionCard>
    )
  }
  // Numeric labels (histogram bins) get a clean linear axis with "nice" round ticks
  // shared with the rest of the app (chart-ticks). Categorical bars stay as-is.
  const numericLabels = section.data.every((d) => d.label !== '' && !isNaN(Number(d.label)))

  if (numericLabels) {
    const xs = section.data.map((d) => Number(d.label))
    // Checked → axis anchored at zero (niceTicks clamps the low bound to 0).
    // Unchecked → axis tightened on the actual value range: start just below the
    // real min instead of 0, with round ticks laid inside. Without this, niceTicks'
    // floor(min/step)*step collapses to 0 whenever step ≥ min, so toggling did nothing.
    const scale = startAtZero ? niceTicks(xs, true) : tightHistogramScale(xs)
    const chartData = section.data.map((d) => ({ x: Number(d.label), value: d.value }))
    const formatTick = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 })
    return (
      <SectionCard
        title={section.title}
        action={(
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground">
            <Checkbox
              checked={startAtZero}
              onCheckedChange={(v) => setStartAtZero(v === true)}
              className="size-3.5"
            />
            {t('concept_mapping.detail_starts_at_zero')}
          </label>
        )}
      >
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ left: 5, right: 5, bottom: 5 }}>
            <XAxis
              // recharts caches the axis scale and ignores in-place domain/ticks
              // changes, so key it on the domain to force a fresh scale on toggle.
              key={scale ? `${scale.domain[0]}-${scale.domain[1]}` : 'auto'}
              type="number"
              dataKey="x"
              domain={scale ? scale.domain : ['dataMin', 'dataMax']}
              ticks={scale?.ticks}
              tick={{ fontSize: 10 }}
              tickFormatter={formatTick}
            />
            <YAxis tick={{ fontSize: 10 }} width={45} domain={[0, 'auto']} />
            <Tooltip
              {...TOOLTIP_STYLE}
              cursor={{ fill: 'var(--color-accent)' }}
              labelFormatter={(label) => formatTick(Number(label))}
            />
            <Bar dataKey="value" fill="#60a5fa" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </SectionCard>
    )
  }

  return (
    <SectionCard title={section.title}>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={section.data} margin={{ left: 5, right: 5, bottom: bottomMargin }}>
          <XAxis
            dataKey="label"
            tick={longLabels
              ? <TruncatedTick maxLength={12} />
              : { fontSize: 10 }}
            interval={section.data.length > 20 ? 'preserveStartEnd' : 0}
            angle={longLabels ? -40 : 0}
            textAnchor={longLabels ? 'end' : 'middle'}
            height={bottomMargin}
          />
          <YAxis tick={{ fontSize: 10 }} width={45} domain={[0, 'auto']} />
          <Tooltip {...TOOLTIP_STYLE} cursor={{ fill: 'var(--color-accent)' }} />
          <Bar dataKey="value" fill="#60a5fa" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </SectionCard>
  )
}

/**
 * A profile block: a title, then its content.
 *
 * Card is `flex flex-col gap-6`, so a title and a body as two children sat 24px
 * apart on top of the title's own margin — a heading floating well clear of what
 * it names. Killing the gap here puts the spacing back under the title's control.
 */
function SectionCard({
  title,
  action,
  children,
  className,
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={cn('gap-0 p-3', className)}>
      {(title || action) && (
        <div className="mb-2.5 flex min-h-4 items-center justify-between gap-2">
          {title && <p className="text-xs font-medium">{title}</p>}
          {action}
        </div>
      )}
      {children}
    </Card>
  )
}

export function SectionRenderer({ section }: { section: Section }) {
  if (section.type === 'fields' && section.rows.length > 0) {
    return (
      <SectionCard title={section.title}>
        <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
          {section.rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="shrink-0 text-muted-foreground">{row.label}</span>
              <span className="min-w-0 truncate text-right font-medium" title={row.value}>{row.value}</span>
            </div>
          ))}
        </div>
      </SectionCard>
    )
  }

  if (section.type === 'stats') {
    return (
      <SectionCard title={section.title}>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {section.items.map((item) => (
            <div key={item.label} className="flex items-baseline gap-1.5 text-xs">
              <span className="text-muted-foreground">{item.label}</span>
              <span className={item.highlight ? 'font-bold text-foreground' : 'font-semibold tabular-nums'}>{item.value}</span>
            </div>
          ))}
        </div>
        {section.boxplot && (
          <div className="mt-3">
            <BoxPlot {...section.boxplot} height={44} />
          </div>
        )}
      </SectionCard>
    )
  }

  if (section.type === 'bar' && section.data.length > 0) {
    return <BarSection section={section} />
  }

  if (section.type === 'line' && section.data.length > 0) {
    return (
      <SectionCard title={section.title}>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={section.data} margin={{ left: 5, right: 5, bottom: 5 }}>
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} width={45} />
            <Tooltip {...TOOLTIP_STYLE} />
            <Line type="monotone" dataKey="value" stroke="#60a5fa" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </SectionCard>
    )
  }

  if (section.type === 'pie' && section.data.length > 0) {
    return (
      <SectionCard title={section.title}>
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={section.data}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={40}
              outerRadius={70}
              paddingAngle={2}
            >
              {section.data.map((_, idx) => (
                <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip {...TOOLTIP_STYLE} />
            <Legend layout="vertical" align="right" verticalAlign="middle" iconSize={8} wrapperStyle={{ fontSize: 10 }} />
          </PieChart>
        </ResponsiveContainer>
      </SectionCard>
    )
  }

  if (section.type === 'table' && section.rows.length > 0) {
    return (
      <SectionCard title={section.title}>
        <div className="max-h-[200px] overflow-auto">
          <table className="w-full text-xs">
            <tbody>
              {section.rows.map((row, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="max-w-[120px] truncate py-1 pr-3 text-muted-foreground" title={row.label}>{row.label}</td>
                  <td className="max-w-[180px] truncate py-1 font-medium" title={row.value}>{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    )
  }

  if (section.type === 'columns_table' && section.rows.length > 0) {
    return (
      <SectionCard title={section.title}>
        <div className="max-h-[200px] overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b">
                {section.columns.map((col) => (
                  <th key={col.key} className={`py-1 pr-3 text-[10px] font-medium text-muted-foreground ${col.align === 'right' ? 'text-right' : 'text-left'}`}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row, i) => (
                <tr key={i} className="border-b last:border-0">
                  {section.columns.map((col) => {
                    const val = row[col.key]
                    const display = col.key === 'percentage' && val != null ? `${val}%` : String(val ?? '')
                    return (
                      <td key={col.key} className={`max-w-[180px] truncate py-1 pr-3 ${col.align === 'right' ? 'text-right tabular-nums' : ''}`} title={display}>
                        {display}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    )
  }

  return null
}

// Custom XAxis tick that truncates long labels and shows full value on title
function TruncatedTick({ x, y, payload, maxLength = 12 }: {
  x?: number; y?: number; payload?: { value: string }; maxLength?: number
}) {
  if (!payload) return null
  const full = String(payload.value)
  const truncated = full.length > maxLength ? full.slice(0, maxLength) + '…' : full
  return (
    <g transform={`translate(${x},${y})`}>
      <title>{full}</title>
      <text
        x={0} y={0} dy={4}
        textAnchor="end"
        transform="rotate(-40)"
        fontSize={9}
        fill="currentColor"
        className="text-muted-foreground"
      >
        {truncated}
      </text>
    </g>
  )
}

// --- Extraction helpers ---

/** Keys rendered as sections — excluded from text fields. */
const SECTION_KEYS = new Set([
  'histogram', 'distribution', 'categories', 'values',
  'numeric_data', 'temporal_distribution', 'hospital_units',
  'by_year', 'measurement_frequency', 'categorical_data',
  'records_per_patient',
  // Normalized format keys
  'metadata', 'statistics', 'distributions', 'properties',
])

/**
 * Keys the identity and volume blocks render under a heading.
 *
 * They used to appear as an untitled table above the charts, which said what the
 * concept is without ever saying so. Now that both blocks are titled and laid
 * out in two columns, these must not also fall through to the leftover text
 * fields — an unknown key still does, which is the point of keeping that path.
 */
const IDENTITY_KEYS = new Set([
  'full_name', 'data_source', 'unit', 'data_types', 'missing_rate',
])

/** Keys known to be percentages (display with %). */
const PERCENT_KEYS = new Set([
  'missing_rate', 'completeness', 'percentage', 'missingness',
])

/** Detect whether info uses the normalized format (metadata/statistics/distributions/properties). */
function isNormalizedFormat(info: Record<string, unknown>): boolean {
  if (typeof info !== 'object' || info === null || Array.isArray(info)) return false
  return (
    ('metadata' in info && typeof info.metadata === 'object' && info.metadata !== null) ||
    ('statistics' in info && typeof info.statistics === 'object' && info.statistics !== null) ||
    ('distributions' in info && Array.isArray(info.distributions)) ||
    ('properties' in info && Array.isArray(info.properties))
  )
}

/** Keys that are simple scalar text fields at the top level. */
export function extractTextFields(info: Record<string, unknown>): { label: string; value: string }[] {
  // Normalized format: metadata fields become text fields
  if (isNormalizedFormat(info)) {
    if (info.metadata && typeof info.metadata === 'object' && !Array.isArray(info.metadata)) {
      const md = info.metadata as Record<string, unknown>
      const items: { label: string; value: string }[] = []
      for (const [key, val] of Object.entries(md)) {
        if (val == null) continue
        if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
          items.push({ label: formatLabel(key), value: formatValue(key, val) })
        }
      }
      return items
    }
    return []
  }

  // Legacy format
  const items: { label: string; value: string }[] = []
  const statsKeys = new Set([
    'count', 'n', 'total', 'mean', 'median', 'min', 'max', 'std', 'sd',
    'granularity', 'completeness', 'uniqueCount', 'nullCount', 'recordCount',
    'patientCount',
  ])
  for (const [key, val] of Object.entries(info)) {
    if (SECTION_KEYS.has(key)) continue
    if (statsKeys.has(key)) continue
    // The identity and volume blocks render these under a heading; leaving them
    // here too would print each one twice.
    if (IDENTITY_KEYS.has(key)) continue
    if (val == null) continue
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      items.push({ label: formatLabel(key), value: formatValue(key, val) })
    }
  }
  return items
}

type TFunction = (key: string) => string

/** Build a boxplot data object from a numeric_data or statistics object if enough fields are present. */
function tryBuildBoxplot(nd: Record<string, unknown>): StatsSection['boxplot'] | undefined {
  const get = (keys: string[]) => {
    for (const k of keys) if (nd[k] != null && typeof nd[k] === 'number') return nd[k] as number
    return undefined
  }
  const min = get(['min'])
  const p25 = get(['p25', 'q1'])
  const median = get(['median', 'p50'])
  const p75 = get(['p75', 'q3'])
  const max = get(['max'])
  const mean = get(['mean'])
  if (min == null || p25 == null || median == null || p75 == null || max == null) return undefined
  return { min, p25, median, p75, max, mean }
}

/** Identity of the row being profiled, for the keys the JSON does not carry. */
export interface ConceptIdentity {
  concept_id?: number
  concept_code?: string
  concept_name?: string
  vocabulary_id?: string
  terminology_name?: string
  record_count?: number
  patient_count?: number
}

/**
 * The block that says what this concept IS: its identity in the source
 * vocabulary, its unit, and how much of it there is.
 *
 * Built from the row and the JSON together — `concept_id` and the counts live on
 * the row, `unit` and `data_source` in the profile — because a reader asking
 * "what am I looking at" does not care which of the two it came from.
 */
function extractIdentitySection(
  info: Record<string, unknown>,
  concept: ConceptIdentity | undefined,
  t: TFunction,
): FieldsSection | null {
  const rows: { label: string; value: string }[] = []
  const push = (label: string, value: unknown) => {
    if (value == null || value === '') return
    rows.push({ label, value: typeof value === 'number' ? fmtNum(value) : String(value) })
  }

  // Vocabulary first: it is what a code and a name are read RELATIVE to, so it
  // frames the rows under it rather than trailing them.
  push(t('concept_mapping.detail_field_vocabulary'), concept?.terminology_name ?? concept?.vocabulary_id)
  push(t('concept_mapping.detail_field_concept_name'), concept?.concept_name ?? info.full_name)
  push(t('concept_mapping.detail_field_concept_id'), concept?.concept_id)
  push(t('concept_mapping.detail_field_concept_code'), concept?.concept_code)
  push(t('concept_mapping.detail_field_data_source'), info.data_source)
  push(t('concept_mapping.detail_field_unit'), info.unit)
  push(
    t('concept_mapping.detail_field_data_types'),
    Array.isArray(info.data_types) ? info.data_types.join(', ') : info.data_types,
  )

  if (rows.length === 0) return null
  return { type: 'fields', title: t('concept_mapping.detail_identity'), rows }
}

/**
 * The block that says how MUCH of this concept there is, and how it is spread
 * over patients and time.
 *
 * Records, patients, records-per-patient, the typical interval and the missing
 * rate all answer the same question — is this variable dense or sparse, and can
 * it be trusted — so they read better together than as five separate rows and
 * two one-line cards.
 */
function extractVolumeSection(
  info: Record<string, unknown>,
  concept: ConceptIdentity | undefined,
  t: TFunction,
): FieldsSection | null {
  const rows: { label: string; value: string }[] = []
  const push = (label: string, value: unknown, suffix = '') => {
    if (value == null || value === '') return
    const text = typeof value === 'number' ? fmtNum(value) : String(value)
    rows.push({ label, value: `${text}${suffix}` })
  }

  push(t('concept_mapping.detail_field_records'), concept?.record_count)
  push(t('concept_mapping.detail_field_patients'), concept?.patient_count)

  const perPatient = asObject(info.records_per_patient)
  if (perPatient) {
    push(t('concept_mapping.detail_field_per_patient_mean'), perPatient.mean)
    push(t('concept_mapping.detail_field_per_patient_median'), perPatient.median)
    if (perPatient.min != null && perPatient.max != null) {
      push(
        t('concept_mapping.detail_field_per_patient_range'),
        `${fmtNum(Number(perPatient.min))} – ${fmtNum(Number(perPatient.max))}`,
      )
    }
  }

  // The typical interval was a whole card holding one row; it belongs with the
  // other density facts, next to the counts it qualifies.
  const mf = info.measurement_frequency
  if (typeof mf === 'string') push(t('concept_mapping.detail_field_typical_interval'), mf)
  else {
    const obj = asObject(mf)
    if (obj) push(t('concept_mapping.detail_field_typical_interval'), obj.typical_interval)
  }

  // French puts a narrow no-break space before the percent sign; English does
  // not. Non-breaking either way, so the number never wraps away from its unit.
  push(t('concept_mapping.detail_field_missing_rate'), info.missing_rate, percentSuffix(t))

  if (rows.length === 0) return null
  return { type: 'fields', title: t('concept_mapping.detail_volume'), rows }
}

/**
 * The percent sign with whatever space the locale puts before it.
 *
 * French sets a narrow no-break space between a number and `%`; English sets
 * none. The key carries the space so translators own the typography, and it is
 * no-break so a value never wraps away from its unit.
 */
function percentSuffix(t: TFunction): string {
  return t('common.percent_suffix')
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Extract all visualizable sections from the JSON. */
export function extractSections(
  info: Record<string, unknown>,
  t: TFunction,
  concept?: ConceptIdentity,
): Section[] {
  // Use normalized parser if detected
  if (isNormalizedFormat(info)) return extractNormalizedSections(info, t)

  const sections: Section[] = []

  const identity = extractIdentitySection(info, concept, t)
  if (identity) sections.push(identity)
  const volume = extractVolumeSection(info, concept, t)
  if (volume) sections.push(volume)

  // 1. numeric_data object → compact stats row + boxplot
  if (info.numeric_data && typeof info.numeric_data === 'object' && !Array.isArray(info.numeric_data)) {
    const nd = info.numeric_data as Record<string, unknown>
    const items: StatsSection['items'] = []
    const statOrder = [
      { key: 'min', label: 'Min' },
      { key: 'p5', label: 'P5' },
      { key: 'p25', label: 'P25' },
      { key: 'median', label: 'Median', highlight: true },
      { key: 'mean', label: 'Mean', highlight: true },
      { key: 'p75', label: 'P75' },
      { key: 'p95', label: 'P95' },
      { key: 'max', label: 'Max' },
      { key: 'sd', label: 'SD' },
      { key: 'std', label: 'SD' },
    ]
    for (const def of statOrder) {
      const val = nd[def.key]
      if (val == null) continue
      items.push({
        label: def.label,
        value: typeof val === 'number' ? fmtNum(val) : String(val),
        highlight: def.highlight,
      })
    }
    const covered = new Set(statOrder.map((s) => s.key))
    for (const [key, val] of Object.entries(nd)) {
      if (covered.has(key) || val == null) continue
      items.push({
        label: formatLabel(key),
        value: typeof val === 'number' ? fmtNum(val) : String(val),
      })
    }
    if (items.length > 0) {
      sections.push({ type: 'stats', title: t('concept_mapping.detail_descriptive_stats'), items, boxplot: tryBuildBoxplot(nd) })
    }
  }

  // Top-level numeric fields (legacy flat format)
  const topStats = extractTopLevelStats(info)
  if (topStats.length > 0) {
    sections.push({ type: 'stats', items: topStats })
  }

  // 2. histogram → bar chart
  if (Array.isArray(info.histogram)) {
    sections.push({
      type: 'bar',
      title: t('concept_mapping.detail_histogram'),
      data: info.histogram.map((item: Record<string, unknown>) => ({
        label: String(item.x ?? item.bucket ?? item.label ?? item.bin ?? ''),
        value: Number(item.count ?? item.value ?? item.n ?? 0),
      })),
    })
  }

  // 3. distribution → bar chart
  if (Array.isArray(info.distribution)) {
    sections.push({
      type: 'bar',
      title: typeof info.distributionTitle === 'string' ? info.distributionTitle : t('concept_mapping.detail_distribution'),
      data: info.distribution.map((item: Record<string, unknown>) => ({
        label: String(item.label ?? item.name ?? item.bucket ?? item.key ?? ''),
        value: Number(item.value ?? item.count ?? item.n ?? 0),
      })),
    })
  }

  // 4. categories → pie (≤8) or bar
  if (info.categories && typeof info.categories === 'object' && !Array.isArray(info.categories)) {
    const entries = Object.entries(info.categories as Record<string, unknown>)
    if (entries.length > 0) {
      sections.push({
        type: entries.length <= 8 ? 'pie' : 'bar',
        title: t('concept_mapping.detail_categories'),
        data: entries.map(([label, value]) => ({ label, value: Number(value ?? 0) })),
      })
    }
  }

  // 4b. categorical_data array → table with named columns + pie/bar chart.
  // Both render the same numbers, so they must not share one title: two cards
  // headed "Categories" read as the same block drawn twice by mistake.
  if (Array.isArray(info.categorical_data) && info.categorical_data.length > 0) {
    const items = info.categorical_data as Record<string, unknown>[]
    sections.push({
      type: 'columns_table',
      title: t('concept_mapping.detail_categories_table'),
      columns: [
        { key: 'category', label: t('concept_mapping.detail_col_value'), align: 'left' },
        { key: 'count', label: t('concept_mapping.detail_col_count'), align: 'right' },
        { key: 'percentage', label: '%', align: 'right' },
      ],
      rows: items,
    })
    sections.push({
      type: items.length <= 8 ? 'pie' : 'bar',
      title: items.length <= 8
        ? t('concept_mapping.detail_categories_chart')
        : t('concept_mapping.detail_categories_histogram'),
      data: items.map((item) => ({
        label: String(item.category ?? item.label ?? item.name ?? ''),
        value: Number(item.count ?? item.value ?? 0),
      })),
    })
  }

  // 5. values array → bar chart
  if (Array.isArray(info.values) && !info.histogram && !info.distribution) {
    sections.push({
      type: 'bar',
      title: t('concept_mapping.detail_values'),
      data: info.values.map((item: Record<string, unknown>) => ({
        label: String(item.label ?? item.name ?? item.key ?? ''),
        value: Number(item.value ?? item.count ?? 0),
      })),
    })
  }

  // 6. temporal_distribution → line chart
  if (info.temporal_distribution && typeof info.temporal_distribution === 'object') {
    const td = info.temporal_distribution as Record<string, unknown>
    if (Array.isArray(td.by_year)) {
      sections.push({
        type: 'line',
        title: `${t('concept_mapping.detail_temporal')}${td.start_date || td.end_date ? ` (${td.start_date ?? '?'} → ${td.end_date ?? '?'})` : ''}`,
        data: td.by_year.map((item: Record<string, unknown>) => ({
          label: String(item.year ?? ''),
          value: Number(item.percentage ?? item.count ?? item.value ?? 0),
        })),
      })
    }
  }

  // 7. hospital_units → horizontal bars. Ward names are long, and on a vertical
  // axis they end up rotated and cut to a dozen characters; along Y they get the
  // panel's full width and stay readable.
  if (Array.isArray(info.hospital_units) && info.hospital_units.length > 0) {
    const units = info.hospital_units as Record<string, unknown>[]
    sections.push({
      type: 'bar',
      title: t('concept_mapping.detail_hospital_units'),
      horizontal: true,
      valueSuffix: units.some((item) => item.percentage != null) ? '%' : '',
      data: units.map((item) => ({
        label: String(item.unit ?? item.name ?? item.label ?? ''),
        value: Number(item.percentage ?? item.count ?? item.value ?? 0),
      })),
    })
  }

  // measurement_frequency is folded into the volume block above — a card holding
  // one "typical interval" row was a heading with nothing under it.

  // 9. Any remaining arrays of objects → table
  for (const [key, val] of Object.entries(info)) {
    if (SECTION_KEYS.has(key)) continue
    if (!Array.isArray(val) || val.length === 0) continue
    if (typeof val[0] !== 'object' || val[0] === null) continue
    const rows: { label: string; value: string }[] = val.map((item: Record<string, unknown>) => {
      const entries = Object.entries(item)
      const label = entries[0] ? String(entries[0][1] ?? '') : ''
      const value = entries.slice(1).map(([, v]) => String(v ?? '')).join(', ')
      return { label, value }
    })
    sections.push({ type: 'table', title: formatLabel(key), rows })
  }

  return sections
}

/** Top-level numeric/stat fields (legacy flat format). */
function extractTopLevelStats(info: Record<string, unknown>): StatsSection['items'] {
  const items: StatsSection['items'] = []
  const defs: { key: string; label: string; highlight?: boolean }[] = [
    { key: 'count', label: 'Count', highlight: true },
    { key: 'n', label: 'N', highlight: true },
    { key: 'total', label: 'Total', highlight: true },
    { key: 'mean', label: 'Mean', highlight: true },
    { key: 'median', label: 'Median', highlight: true },
    { key: 'min', label: 'Min' },
    { key: 'max', label: 'Max' },
    { key: 'std', label: 'SD' },
    { key: 'sd', label: 'SD' },
    { key: 'granularity', label: 'Granularity' },
    { key: 'completeness', label: 'Completeness' },
    { key: 'uniqueCount', label: 'Unique' },
    { key: 'nullCount', label: 'Nulls' },
    { key: 'recordCount', label: 'Records' },
    { key: 'patientCount', label: 'Patients' },
    // missing_rate is reported by the volume block, with the counts it qualifies.
    { key: 'missingness', label: 'Missingness' },
  ]
  for (const def of defs) {
    const val = info[def.key]
    if (val == null) continue
    items.push({
      label: def.label,
      value: formatValue(def.key, val),
      highlight: def.highlight,
    })
  }
  return items
}

/** Format a value, adding % for known percentage keys. */
function formatValue(key: string, val: unknown): string {
  if (typeof val === 'number') {
    if (PERCENT_KEYS.has(key)) return `${fmtNum(val)}%`
    return fmtNum(val)
  }
  if (typeof val === 'string' && PERCENT_KEYS.has(key) && !val.includes('%')) {
    return `${val}%`
  }
  return String(val)
}

/** Format a number with reasonable precision. */
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString()
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/** Extract sections from normalized format (metadata/statistics/distributions/properties). */
function extractNormalizedSections(info: Record<string, unknown>, t: TFunction): Section[] {
  const sections: Section[] = []

  // statistics → compact stats row + boxplot
  if (info.statistics && typeof info.statistics === 'object' && !Array.isArray(info.statistics)) {
    const stats = info.statistics as Record<string, unknown>
    const items: StatsSection['items'] = []
    const statOrder = [
      { key: 'min', label: 'Min' },
      { key: 'p5', label: 'P5' },
      { key: 'p25', label: 'P25' },
      { key: 'median', label: 'Median', highlight: true },
      { key: 'mean', label: 'Mean', highlight: true },
      { key: 'p75', label: 'P75' },
      { key: 'p95', label: 'P95' },
      { key: 'max', label: 'Max' },
      { key: 'sd', label: 'SD' },
      { key: 'std', label: 'SD' },
      { key: 'count', label: 'Count', highlight: true },
      { key: 'n', label: 'N', highlight: true },
    ]
    const covered = new Set(statOrder.map((s) => s.key))
    for (const def of statOrder) {
      const val = stats[def.key]
      if (val == null) continue
      items.push({
        label: def.label,
        value: typeof val === 'number' ? fmtNum(val) : String(val),
        highlight: def.highlight,
      })
    }
    for (const [key, val] of Object.entries(stats)) {
      if (covered.has(key) || val == null) continue
      items.push({
        label: formatLabel(key),
        value: typeof val === 'number' ? fmtNum(val) : String(val),
      })
    }
    if (items.length > 0) {
      sections.push({ type: 'stats', title: t('concept_mapping.detail_statistics'), items, boxplot: tryBuildBoxplot(stats) })
    }
  }

  // distributions[] → render each by type
  if (Array.isArray(info.distributions)) {
    for (const dist of info.distributions as Record<string, unknown>[]) {
      if (!dist || typeof dist !== 'object') continue
      const name = String(dist.name ?? t('concept_mapping.detail_distribution'))
      const chartType = String(dist.type ?? 'bar') as 'bar' | 'pie' | 'line'
      const data = Array.isArray(dist.data)
        ? (dist.data as Record<string, unknown>[]).map((item) => ({
            label: String(item.label ?? item.name ?? item.x ?? ''),
            value: Number(item.value ?? item.count ?? 0),
          }))
        : []
      if (data.length === 0) continue
      if (chartType === 'pie') {
        sections.push({ type: 'pie', title: name, data })
      } else if (chartType === 'line') {
        sections.push({ type: 'line', title: name, data })
      } else {
        sections.push({ type: 'bar', title: name, data })
      }
    }
  }

  // properties[] → table
  if (Array.isArray(info.properties) && info.properties.length > 0) {
    const rows = (info.properties as Record<string, unknown>[]).map((item) => ({
      label: String(item.label ?? item.name ?? ''),
      value: String(item.value ?? ''),
    }))
    sections.push({ type: 'table', title: t('concept_mapping.detail_properties'), rows })
  }

  return sections
}

/** snake_case / camelCase → Title Case */
function formatLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
