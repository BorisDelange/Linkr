import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Code2 } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, LineChart, Line } from 'recharts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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

export function ConceptDetailView({ concept, onBack }: ConceptDetailViewProps) {
  const { t } = useTranslation()
  const rawInfo = concept.info_json
  const info = (rawInfo && typeof rawInfo === 'object' && !Array.isArray(rawInfo)) ? rawInfo : null
  const [jsonModalOpen, setJsonModalOpen] = useState(false)

  const sections = info ? extractSections(info, t) : []
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
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
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
          {/* Text fields */}
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

          {/* Sections */}
          {sections.map((section, i) => (
            <SectionRenderer key={i} section={section} />
          ))}

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
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Code2 size={14} />
              {t('concept_mapping.detail_raw_json')}
              {concept.concept_name && (
                <span className="truncate text-xs font-normal text-muted-foreground">— {concept.concept_name}</span>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto">
            <pre className="overflow-x-auto whitespace-pre rounded-md bg-muted/50 p-4 text-[11px] leading-relaxed">
              {JSON.stringify(info, null, 2)}
            </pre>
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

export interface ColumnsTableSection {
  type: 'columns_table'
  title: string
  columns: { key: string; label: string; align?: 'left' | 'right' }[]
  rows: Record<string, unknown>[]
}

export type Section = StatsSection | BarChartSection | PieChartSection | LineChartSection | TableSection | ColumnsTableSection

// Custom boxplot shape
function BoxPlot({ min, p25, median, p75, max, mean, height = 40 }: {
  min: number; p25: number; median: number; p75: number; max: number; mean?: number; height?: number
}) {
  const range = max - min || 1
  const pct = (v: number) => `${((v - min) / range) * 100}%`
  const cy = height / 2

  return (
    <svg width="100%" height={height} className="overflow-visible">
      {/* Whisker lines */}
      <line x1={pct(min)} y1={cy} x2={pct(p25)} y2={cy} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />
      <line x1={pct(p75)} y1={cy} x2={pct(max)} y2={cy} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />
      {/* Whisker end caps */}
      <line x1={pct(min)} y1={cy - 6} x2={pct(min)} y2={cy + 6} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />
      <line x1={pct(max)} y1={cy - 6} x2={pct(max)} y2={cy + 6} stroke="currentColor" strokeWidth={1.5} className="text-muted-foreground" />
      {/* IQR box */}
      <rect
        x={pct(p25)} y={cy - 10} width={`${((p75 - p25) / range) * 100}%`} height={20}
        fill="var(--color-primary)" fillOpacity={0.15} stroke="var(--color-primary)" strokeWidth={1.5} rx={2}
      />
      {/* Median line */}
      <line x1={pct(median)} y1={cy - 10} x2={pct(median)} y2={cy + 10} stroke="var(--color-primary)" strokeWidth={2} />
      {/* Mean dot */}
      {mean !== undefined && (
        <circle cx={pct(mean)} cy={cy} r={3} fill="#fb923c" />
      )}
      {/* Axis labels */}
      <text x={pct(min)} y={height} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">{fmtNum(min)}</text>
      <text x={pct(p25)} y={height} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">{fmtNum(p25)}</text>
      <text x={pct(median)} y={height} textAnchor="middle" fontSize={9} fill="var(--color-primary)">{fmtNum(median)}</text>
      <text x={pct(p75)} y={height} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">{fmtNum(p75)}</text>
      <text x={pct(max)} y={height} textAnchor="middle" fontSize={9} fill="currentColor" className="text-muted-foreground">{fmtNum(max)}</text>
    </svg>
  )
}

export function SectionRenderer({ section }: { section: Section }) {
  if (section.type === 'stats') {
    return (
      <Card className="p-3">
        {section.title && <p className="mb-2 text-xs font-medium">{section.title}</p>}
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
      </Card>
    )
  }

  if (section.type === 'bar' && section.data.length > 0) {
    const longLabels = section.longLabels || section.data.some((d) => d.label.length > 6)
    const bottomMargin = longLabels ? 70 : 25
    // Detect numeric labels (histogram bins) to apply rounding
    const numericLabels = section.data.every((d) => d.label !== '' && !isNaN(Number(d.label)))
    // Compute a smart rounding function based on the step between bins
    const formatXTick = numericLabels
      ? (() => {
          const nums = section.data.map((d) => Number(d.label)).filter((n) => !isNaN(n))
          // Find the minimum step between consecutive bins
          let minStep = Infinity
          for (let i = 1; i < nums.length; i++) {
            const step = Math.abs(nums[i] - nums[i - 1])
            if (step > 0 && step < minStep) minStep = step
          }
          // Choose decimal places so we don't lose bin distinction
          const decimals = minStep >= 1 ? 0 : minStep >= 0.1 ? 1 : 2
          return (val: string) => {
            const n = Number(val)
            return n.toFixed(decimals)
          }
        })()
      : undefined
    return (
      <Card className="p-3">
        <p className="mb-2 text-xs font-medium">{section.title}</p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={section.data} margin={{ left: 5, right: 5, bottom: bottomMargin }}>
            <XAxis
              dataKey="label"
              tick={longLabels
                ? <TruncatedTick maxLength={12} />
                : { fontSize: 10 }}
              tickFormatter={!longLabels ? formatXTick : undefined}
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
      </Card>
    )
  }

  if (section.type === 'line' && section.data.length > 0) {
    return (
      <Card className="p-3">
        <p className="mb-2 text-xs font-medium">{section.title}</p>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={section.data} margin={{ left: 5, right: 5, bottom: 5 }}>
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} width={45} />
            <Tooltip {...TOOLTIP_STYLE} />
            <Line type="monotone" dataKey="value" stroke="#60a5fa" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </Card>
    )
  }

  if (section.type === 'pie' && section.data.length > 0) {
    return (
      <Card className="p-3">
        <p className="mb-2 text-xs font-medium">{section.title}</p>
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
      </Card>
    )
  }

  if (section.type === 'table' && section.rows.length > 0) {
    return (
      <Card className="p-3">
        <p className="mb-2 text-xs font-medium">{section.title}</p>
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
      </Card>
    )
  }

  if (section.type === 'columns_table' && section.rows.length > 0) {
    return (
      <Card className="p-3">
        <p className="mb-2 text-xs font-medium">{section.title}</p>
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
      </Card>
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
  // Normalized format keys
  'metadata', 'statistics', 'distributions', 'properties',
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
    if (val == null) continue
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      items.push({ label: formatLabel(key), value: formatValue(key, val) })
    }
  }
  // measurement_frequency as string (new format) — show as text field
  if (typeof info.measurement_frequency === 'string') {
    items.push({ label: formatLabel('measurement_frequency'), value: info.measurement_frequency })
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

/** Extract all visualizable sections from the JSON. */
export function extractSections(info: Record<string, unknown>, t: TFunction): Section[] {
  // Use normalized parser if detected
  if (isNormalizedFormat(info)) return extractNormalizedSections(info, t)

  const sections: Section[] = []

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

  // 4b. categorical_data array → table with named columns + pie/bar chart
  if (Array.isArray(info.categorical_data) && info.categorical_data.length > 0) {
    const items = info.categorical_data as Record<string, unknown>[]
    // Table with columns
    sections.push({
      type: 'columns_table',
      title: t('concept_mapping.detail_categories'),
      columns: [
        { key: 'category', label: t('concept_mapping.detail_col_value'), align: 'left' },
        { key: 'count', label: t('concept_mapping.detail_col_count'), align: 'right' },
        { key: 'percentage', label: '%', align: 'right' },
      ],
      rows: items,
    })
    // Also add a pie (≤8) or bar chart
    sections.push({
      type: items.length <= 8 ? 'pie' : 'bar',
      title: t('concept_mapping.detail_categories'),
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

  // 7. hospital_units → pie (≤8) or bar with long labels
  if (Array.isArray(info.hospital_units) && info.hospital_units.length > 0) {
    const units = info.hospital_units as Record<string, unknown>[]
    if (units.length <= 8) {
      sections.push({
        type: 'pie',
        title: t('concept_mapping.detail_hospital_units'),
        data: units.map((item) => ({
          label: String(item.unit ?? item.name ?? item.label ?? ''),
          value: Number(item.percentage ?? item.count ?? item.value ?? 0),
        })),
      })
    } else {
      sections.push({
        type: 'bar',
        title: t('concept_mapping.detail_hospital_units'),
        longLabels: true,
        data: units.map((item) => ({
          label: String(item.unit ?? item.name ?? item.label ?? ''),
          value: Number(item.percentage ?? item.count ?? item.value ?? 0),
        })),
      })
    }
  }

  // 8. measurement_frequency → string (new format) or table (legacy object format)
  if (info.measurement_frequency != null) {
    if (typeof info.measurement_frequency === 'string') {
      // New format: direct string value — handled as text field below (removed from SECTION_KEYS would show it)
      // We don't need a section for it, it will appear in textFields
    } else if (typeof info.measurement_frequency === 'object') {
      const mf = info.measurement_frequency as Record<string, unknown>
      const rows: { label: string; value: string }[] = []
      for (const [key, val] of Object.entries(mf)) {
        if (val != null) rows.push({ label: formatLabel(key), value: String(val) })
      }
      if (rows.length > 0) {
        sections.push({ type: 'table', title: t('concept_mapping.detail_measurement_frequency'), rows })
      }
    }
  }

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
    { key: 'missing_rate', label: 'Missing rate' },
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
