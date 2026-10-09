import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DatePickerField, fromIsoDay } from '@/components/ui/date-picker-field'
import { Slider } from '@/components/ui/slider'
import { formatDate } from '@/lib/format-helpers'
import { daysBetween, valueToSlider, sliderToValue, type DateBounds } from './date-slider'
import { cn } from '@/lib/utils'
import type { DatePreset, DatePresetUnit, FilterValue } from '@/types'
import { presetLabel, resolveRelativeWindow } from './date-presets'

// --- Numeric Filter ---

export function NumericFilter({
  columnId,
  rows,
  value,
  onChange,
}: {
  columnId: string
  rows: Record<string, unknown>[]
  value?: { type: 'numeric'; min: number | null; max: number | null }
  onChange: (value: FilterValue) => void
}) {
  const { t } = useTranslation()
  const range = useMemo(() => {
    let min = Infinity
    let max = -Infinity
    for (const row of rows) {
      const v = Number(row[columnId])
      if (!isNaN(v)) {
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 100 : max }
  }, [rows, columnId])

  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="space-y-0.5">
        <span className="text-[10px] text-muted-foreground">{t('dashboard.filter_min', 'Min')} ({range.min})</span>
        <Input
          type="number"
          className="h-6 text-xs"
          placeholder={String(range.min)}
          value={value?.min ?? ''}
          onChange={(e) => {
            const v = e.target.value === '' ? null : Number(e.target.value)
            onChange({ type: 'numeric', min: v, max: value?.max ?? null })
          }}
        />
      </div>
      <div className="space-y-0.5">
        <span className="text-[10px] text-muted-foreground">{t('dashboard.filter_max', 'Max')} ({range.max})</span>
        <Input
          type="number"
          className="h-6 text-xs"
          placeholder={String(range.max)}
          value={value?.max ?? ''}
          onChange={(e) => {
            const v = e.target.value === '' ? null : Number(e.target.value)
            onChange({ type: 'numeric', min: value?.min ?? null, max: v })
          }}
        />
      </div>
    </div>
  )
}

// --- Numeric: two disjoint ranges (OR) ---

export function DoubleNumericFilter({
  columnId,
  rows,
  value,
  onChange,
}: {
  columnId: string
  rows: Record<string, unknown>[]
  value?: { type: 'numeric-double'; min1: number | null; max1: number | null; min2: number | null; max2: number | null }
  onChange: (value: FilterValue) => void
}) {
  const { t } = useTranslation()
  const range = useMemo(() => {
    let min = Infinity
    let max = -Infinity
    for (const row of rows) {
      const v = Number(row[columnId])
      if (!isNaN(v)) {
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 100 : max }
  }, [rows, columnId])

  const current = value ?? { type: 'numeric-double' as const, min1: null, max1: null, min2: null, max2: null }
  const emit = (patch: Partial<Omit<typeof current, 'type'>>) =>
    onChange({ ...current, ...patch })
  const num = (s: string) => (s === '' ? null : Number(s))

  const rangeRow = (
    minKey: 'min1' | 'min2',
    maxKey: 'max1' | 'max2',
    label: string,
  ) => (
    <div className="space-y-0.5">
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
      <div className="grid grid-cols-2 gap-2">
        <Input
          type="number"
          className="h-6 text-xs"
          placeholder={`${t('dashboard.filter_min', 'Min')} (${range.min})`}
          value={current[minKey] ?? ''}
          onChange={(e) => emit({ [minKey]: num(e.target.value) })}
        />
        <Input
          type="number"
          className="h-6 text-xs"
          placeholder={`${t('dashboard.filter_max', 'Max')} (${range.max})`}
          value={current[maxKey] ?? ''}
          onChange={(e) => emit({ [maxKey]: num(e.target.value) })}
        />
      </div>
    </div>
  )

  return (
    <div className="space-y-2">
      {rangeRow('min1', 'max1', t('dashboard.filter_range_1', 'Range 1'))}
      {rangeRow('min2', 'max2', t('dashboard.filter_range_2', 'Range 2'))}
    </div>
  )
}

// --- Date Filter ---

export function DateFilter({
  value,
  presets,
  onChange,
  bounds,
  withSlider,
  withInputs,
}: {
  value?: { type: 'date'; from: string | null; to: string | null } | { type: 'date-relative'; count: number; unit: DatePresetUnit }
  presets: DatePreset[]
  onChange: (value: FilterValue) => void
  /** The column's own first and last day; null while unknown (still loading, or a
   *  column with no parseable dates), in which case the pickers stay unbounded. */
  bounds?: DateBounds | null
  withSlider: boolean
  withInputs: boolean
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const isRelative = value?.type === 'date-relative'
  const from = value?.type === 'date' ? value.from : null
  const to = value?.type === 'date' ? value.to : null
  const hasValue = isRelative || !!(from || to)

  // Calendars open on, and are limited to, the range the data actually covers —
  // picking a day with no rows behind it can only ever return nothing.
  const minDate = bounds ? fromIsoDay(bounds.min) : undefined
  const maxDate = bounds ? fromIsoDay(bounds.max) : undefined
  const pickerBounds = minDate && maxDate ? { before: minDate, after: maxDate } : undefined

  // A quick range drives the slider too, so its handles show the window it selects.
  const shown = isRelative ? resolveRelativeWindow(value.count, value.unit) : { from, to }
  const span = bounds ? daysBetween(bounds.min, bounds.max) : 0
  const [start, end] = bounds ? valueToSlider(bounds, shown.from, shown.to) : [0, 0]

  // No usable range: a slider with no scale would be a dead control, so say so.
  if (withSlider && !withInputs && !bounds) {
    return <p className="text-[10px] text-muted-foreground">{t('dashboard.filter_no_date_range')}</p>
  }

  return (
    <div className="space-y-1.5">
      {withInputs && presets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => {
            const active = isRelative && value.count === p.count && value.unit === p.unit
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onChange(active ? { type: 'date', from: null, to: null } : { type: 'date-relative', count: p.count, unit: p.unit })}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted',
                )}
              >
                {presetLabel(p.count, p.unit, lang)}
              </button>
            )
          })}
        </div>
      )}
      {withSlider && bounds && (
        <div className="space-y-3">
          {!withInputs && (
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>{formatDate(from ?? bounds.min, lang)}</span>
              <span>{formatDate(to ?? bounds.max, lang)}</span>
            </div>
          )}
          <Slider
            min={0}
            max={span}
            step={1}
            value={[start, end]}
            onValueChange={([s, e]) => onChange({ type: 'date', ...sliderToValue(bounds, [s, e]) })}
            // A single-day column has a zero-width scale; the thumbs would overlap
            // with nothing to choose between.
            disabled={span === 0}
          />
        </div>
      )}
      {withInputs && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <span className="text-[10px] font-medium text-muted-foreground">{t('dashboard.filter_date_from', 'From')}</span>
            <DatePickerField
              value={from ?? undefined}
              onChange={(v) => onChange({ type: 'date', from: v ?? null, to })}
              // Unset means "from the beginning of the data", so show that day rather
              // than an empty box the reader has to interpret.
              placeholder={bounds ? formatDate(bounds.min, lang) : undefined}
              defaultMonth={minDate}
              disabledDays={pickerBounds}
            />
          </div>
          <div className="space-y-1">
            <span className="text-[10px] font-medium text-muted-foreground">{t('dashboard.filter_date_to', 'To')}</span>
            <DatePickerField
              value={to ?? undefined}
              onChange={(v) => onChange({ type: 'date', from, to: v ?? null })}
              placeholder={bounds ? formatDate(bounds.max, lang) : undefined}
              defaultMonth={maxDate}
              disabledDays={pickerBounds}
            />
          </div>
        </div>
      )}
      {hasValue && (
        <Button
          variant="ghost"
          size="xs"
          className="h-5 gap-1 text-[10px] text-muted-foreground"
          onClick={() => onChange({ type: 'date', from: null, to: null })}
        >
          <X size={10} />
          {t('common.clear', 'Clear')}
        </Button>
      )}
    </div>
  )
}

/** Read-only badge showing a filter's scope (all tabs vs specific tabs/widgets), with the
 *  targets listed on hover. Green = applies everywhere; amber = scoped to a subset. */
