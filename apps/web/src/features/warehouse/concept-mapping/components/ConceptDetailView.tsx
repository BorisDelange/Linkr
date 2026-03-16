import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ChevronDown, ChevronRight, Code2 } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, LineChart, Line } from 'recharts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
  const info = concept.info_json
  const [showJson, setShowJson] = useState(false)

  const sections = info ? extractSections(info) : []
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
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <div className="space-y-4">
          {/* Text fields */}
          {textFields.length > 0 && (
            <Card className="p-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {textFields.map((item) => (
                  <div key={item.label} className="flex items-baseline gap-2 text-xs">
                    <span className="shrink-0 text-muted-foreground">{item.label}</span>
                    <span className="truncate font-medium" title={item.value}>{item.value}</span>
                  </div>
                ))}
              </div>
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

          {/* Raw JSON — always available as collapsible */}
          {info && (
            <div className="rounded border">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/50"
                onClick={() => setShowJson(!showJson)}
              >
                <Code2 size={12} />
                {t('concept_mapping.detail_raw_json')}
                {showJson ? <ChevronDown size={12} className="ml-auto" /> : <ChevronRight size={12} className="ml-auto" />}
              </button>
              {showJson && (
                <pre className="max-h-[300px] overflow-auto border-t bg-muted/30 p-3 text-[10px] leading-relaxed">
                  {JSON.stringify(info, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// --- Section types ---

interface StatsSection {
  type: 'stats'
  title?: string
  items: { label: string; value: string; highlight?: boolean }[]
}

interface BarChartSection {
  type: 'bar'
  title: string
  data: { label: string; value: number }[]
}

interface PieChartSection {
  type: 'pie'
  title: string
  data: { label: string; value: number }[]
}

interface LineChartSection {
  type: 'line'
  title: string
  data: { label: string; value: number }[]
}

interface TableSection {
  type: 'table'
  title: string
  rows: { label: string; value: string }[]
}

type Section = StatsSection | BarChartSection | PieChartSection | LineChartSection | TableSection

function SectionRenderer({ section }: { section: Section }) {
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
      </Card>
    )
  }

  if (section.type === 'bar' && section.data.length > 0) {
    return (
      <Card className="p-3">
        <p className="mb-2 text-xs font-medium">{section.title}</p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={section.data} margin={{ left: 5, right: 5, bottom: 5 }}>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10 }}
              interval={section.data.length > 20 ? 'preserveStartEnd' : 0}
              angle={section.data.length > 8 ? -45 : 0}
              textAnchor={section.data.length > 8 ? 'end' : 'middle'}
              height={section.data.length > 8 ? 60 : 25}
            />
            <YAxis tick={{ fontSize: 10 }} width={45} />
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

  return null
}

// --- Extraction helpers ---

/** Keys rendered as sections — excluded from text fields. */
const SECTION_KEYS = new Set([
  'histogram', 'distribution', 'categories', 'values',
  'numeric_data', 'temporal_distribution', 'hospital_units',
  'by_year', 'measurement_frequency',
  // Normalized format keys
  'metadata', 'statistics', 'distributions', 'properties',
])

/** Keys known to be percentages (display with %). */
const PERCENT_KEYS = new Set([
  'missing_rate', 'completeness', 'percentage', 'missingness',
])

/** Detect whether info uses the normalized format (metadata/statistics/distributions/properties). */
function isNormalizedFormat(info: Record<string, unknown>): boolean {
  return (
    ('metadata' in info && typeof info.metadata === 'object' && info.metadata !== null) ||
    ('statistics' in info && typeof info.statistics === 'object' && info.statistics !== null) ||
    ('distributions' in info && Array.isArray(info.distributions)) ||
    ('properties' in info && Array.isArray(info.properties))
  )
}

/** Keys that are simple scalar text fields at the top level. */
function extractTextFields(info: Record<string, unknown>): { label: string; value: string }[] {
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
    'patientCount', 'missing_rate', 'missingness',
  ])
  for (const [key, val] of Object.entries(info)) {
    if (SECTION_KEYS.has(key)) continue
    if (statsKeys.has(key)) continue
    if (val == null) continue
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      items.push({ label: formatLabel(key), value: formatValue(key, val) })
    }
  }
  return items
}

/** Extract all visualizable sections from the JSON. */
function extractSections(info: Record<string, unknown>): Section[] {
  // Use normalized parser if detected
  if (isNormalizedFormat(info)) return extractNormalizedSections(info)

  const sections: Section[] = []

  // 1. numeric_data object → compact stats row
  if (info.numeric_data && typeof info.numeric_data === 'object' && !Array.isArray(info.numeric_data)) {
    const nd = info.numeric_data as Record<string, unknown>
    const items: StatsSection['items'] = []
    // Define display order and grouping
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
    // Also pick up any remaining keys not in statOrder
    const covered = new Set(statOrder.map((s) => s.key))
    for (const [key, val] of Object.entries(nd)) {
      if (covered.has(key) || val == null) continue
      items.push({
        label: formatLabel(key),
        value: typeof val === 'number' ? fmtNum(val) : String(val),
      })
    }
    if (items.length > 0) {
      sections.push({ type: 'stats', title: 'Descriptive statistics', items })
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
      title: 'Histogram',
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
      title: typeof info.distributionTitle === 'string' ? info.distributionTitle : 'Distribution',
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
        title: 'Categories',
        data: entries.map(([label, value]) => ({ label, value: Number(value ?? 0) })),
      })
    }
  }

  // 5. values array → bar chart
  if (Array.isArray(info.values) && !info.histogram && !info.distribution) {
    sections.push({
      type: 'bar',
      title: 'Values',
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
        title: `Temporal distribution${td.start_date || td.end_date ? ` (${td.start_date ?? '?'} → ${td.end_date ?? '?'})` : ''}`,
        data: td.by_year.map((item: Record<string, unknown>) => ({
          label: String(item.year ?? ''),
          value: Number(item.percentage ?? item.count ?? item.value ?? 0),
        })),
      })
    }
  }

  // 7. hospital_units → pie (≤8) or table
  if (Array.isArray(info.hospital_units) && info.hospital_units.length > 0) {
    const units = info.hospital_units as Record<string, unknown>[]
    if (units.length <= 8) {
      sections.push({
        type: 'pie',
        title: 'Hospital units',
        data: units.map((item) => ({
          label: String(item.unit ?? item.name ?? item.label ?? ''),
          value: Number(item.percentage ?? item.count ?? item.value ?? 0),
        })),
      })
    } else {
      sections.push({
        type: 'table',
        title: 'Hospital units',
        rows: units.map((item) => ({
          label: String(item.unit ?? item.name ?? item.label ?? ''),
          value: item.percentage != null ? `${item.percentage}%` : String(item.count ?? item.value ?? ''),
        })),
      })
    }
  }

  // 8. measurement_frequency → table
  if (info.measurement_frequency && typeof info.measurement_frequency === 'object') {
    const mf = info.measurement_frequency as Record<string, unknown>
    const rows: { label: string; value: string }[] = []
    for (const [key, val] of Object.entries(mf)) {
      if (val != null) rows.push({ label: formatLabel(key), value: String(val) })
    }
    if (rows.length > 0) {
      sections.push({ type: 'table', title: 'Measurement frequency', rows })
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
function extractNormalizedSections(info: Record<string, unknown>): Section[] {
  const sections: Section[] = []

  // statistics → compact stats row
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
      sections.push({ type: 'stats', title: 'Statistics', items })
    }
  }

  // distributions[] → render each by type
  if (Array.isArray(info.distributions)) {
    for (const dist of info.distributions as Record<string, unknown>[]) {
      if (!dist || typeof dist !== 'object') continue
      const name = String(dist.name ?? 'Distribution')
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
    sections.push({ type: 'table', title: 'Properties', rows })
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
