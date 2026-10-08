import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, ChevronsUpDown, ChevronRight, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DatePickerField, fromIsoDay } from '@/components/ui/date-picker-field'
import { Slider } from '@/components/ui/slider'
import { formatDate } from '@/lib/format-helpers'
import {
  daysBetween,
  parseBounds,
  toDayBound,
  valueToSlider,
  sliderToValue,
  type DateBounds,
} from './date-slider'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { DashboardFilter, DashboardFilterScope, DashboardTab, DashboardWidget, DatePreset, DatePresetUnit, FilterValue } from '@/types'
import { localized } from '@/lib/localized'
import { useDatasetStore } from '@/stores/dataset-store'
import { isServerMode } from '@/lib/api-client'
import { fetchColumnDistinct, fetchColumnStats } from '@/lib/api/datasets'
import { presetLabel, resolveRelativeWindow } from './date-presets'
import { FILTER_NONE } from './DashboardDataProvider'
import { isEmptyFilterValue } from './filter-value'

/** One filter as the sidebar shows it: a collapsible header (label, scope badge, optional
 *  actions) over the filter's control. The config dialog's preview renders the same card. */
export function FilterCard({
  fc,
  open,
  onToggle,
  active,
  tabs,
  widgets,
  actions,
  children,
}: {
  fc: DashboardFilter
  open: boolean
  onToggle: () => void
  active: boolean
  tabs: DashboardTab[]
  widgets: DashboardWidget[]
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const { i18n } = useTranslation()
  return (
    <div className={cn('rounded-lg border transition-colors', active && 'border-green-500/40 bg-green-500/5')}>
      <div className="flex h-9 items-center gap-1.5 px-2.5">
        <button
          type="button"
          onClick={onToggle}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight size={13} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className="truncate text-xs font-medium">{localized(fc.label, i18n.language) || fc.columnName}</span>
        </button>
        <FilterScopeBadge scope={fc.scope ?? { type: 'all' }} tabs={tabs} widgets={widgets} />
        {actions}
      </div>
      {open && <div className="px-2.5 pb-2.5">{children}</div>}
    </div>
  )
}

export function IconAction({
  label,
  onClick,
  className,
  children,
}: {
  label: string
  onClick: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" className={cn('shrink-0', className)} onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/** A filter card driven by a draft config, with its own throwaway value so trying the
 *  control never touches the dashboard's applied filters. */
export function FilterPreview({
  fc,
  tabs,
  widgets,
}: {
  fc: DashboardFilter
  tabs: DashboardTab[]
  widgets: DashboardWidget[]
}) {
  const [value, setValue] = useState<FilterValue | undefined>(undefined)
  const [open, setOpen] = useState(true)
  return (
    <FilterCard fc={fc} open={open} onToggle={() => setOpen((o) => !o)} active={!!value} tabs={tabs} widgets={widgets}>
      <FilterControlWithData
        fc={fc}
        value={value}
        onChange={(v) => setValue(isEmptyFilterValue(v) ? undefined : v)}
      />
    </FilterCard>
  )
}

// --- Filter control dispatcher ---

/** Row data feeding a filter control's option/range derivation.
 *
 *  Front-only mode: the real dataset rows (subscribed to `_dirtyVersion` so we
 *  re-render once an async load populates them). Server mode: rows are never
 *  shipped to the browser, so we fetch just what the control needs from the
 *  backend and synthesize a minimal `rows` shape keyed by the column id —
 *  distinct values for categorical inputs, or a [{min},{max}] pair for numeric
 *  ranges — so the existing controls work unchanged. */
function useFilterControlRows(fc: DashboardFilter): Record<string, unknown>[] {
  const { getFileRows, loadFileData, _dirtyVersion } = useDatasetStore()
  const datasetFiles = useDatasetStore((s) => s.files)
  const [serverRows, setServerRows] = useState<Record<string, unknown>[]>([])
  const server = isServerMode()
  const isNumericRange = fc.inputType === 'range' && fc.type !== 'date'

  // The stored columnId can be stale (e.g. a filter imported before its columnId was remapped
  // to the re-parsed server ids), so resolve the CURRENT column id from the dataset by name —
  // the same by-name matching the runtime filter application uses. Falls back to the stored id.
  const fetchColId = useMemo(() => {
    const cols = datasetFiles.find((f) => f.id === fc.datasetFileId)?.columns ?? []
    return cols.find((c) => c.name === fc.columnName)?.id ?? fc.columnId
  }, [datasetFiles, fc.datasetFileId, fc.columnName, fc.columnId])

  // Front-only: nothing else loads the filter's dataset rows into the browser cache
  // (the widget provider only loads the widget's own dataset), so trigger it here.
  useEffect(() => {
    if (!server) void loadFileData(fc.datasetFileId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, fc.datasetFileId])

  useEffect(() => {
    if (!server) return
    let cancelled = false
    // Key synthesized rows by the control's stored columnId (what it reads via row[columnId]),
    // but fetch using the resolved current id.
    const key = fc.columnId
    if (isNumericRange) {
      fetchColumnStats(fc.datasetFileId, fetchColId)
        .then((s) => {
          if (cancelled) return
          const min = s.min as number | undefined
          const max = s.max as number | undefined
          setServerRows(
            min == null || max == null ? [] : [{ [key]: min }, { [key]: max }],
          )
        })
        .catch(() => { if (!cancelled) setServerRows([]) })
    } else {
      fetchColumnDistinct(fc.datasetFileId, fetchColId)
        .then((r) => { if (!cancelled) setServerRows(r.values.map((v) => ({ [key]: v }))) })
        .catch(() => { if (!cancelled) setServerRows([]) })
    }
    return () => { cancelled = true }
  }, [server, isNumericRange, fc.datasetFileId, fc.columnId, fetchColId])

  // Front-only: read the loaded rows; _dirtyVersion in deps forces a re-read when
  // an async load finally populates the module-level cache.
  return useMemo(
    () => (server ? serverRows : getFileRows(fc.datasetFileId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, serverRows, fc.datasetFileId, _dirtyVersion],
  )
}

/** The earliest and latest day held by a date column, used to bound the date pickers
 *  and to scale the slider. Server mode reads the column stats (which already carry
 *  min/max for dates); front-only scans the loaded rows. Null while unknown — the
 *  controls then fall back to being unbounded rather than to a wrong range. */
function useDateColumnBounds(fc: DashboardFilter, rows: Record<string, unknown>[]): DateBounds | null {
  const server = isServerMode()
  const datasetFiles = useDatasetStore((s) => s.files)
  const [serverBounds, setServerBounds] = useState<DateBounds | null>(null)

  const fetchColId = useMemo(() => {
    const cols = datasetFiles.find((f) => f.id === fc.datasetFileId)?.columns ?? []
    return cols.find((c) => c.name === fc.columnName)?.id ?? fc.columnId
  }, [datasetFiles, fc.datasetFileId, fc.columnName, fc.columnId])

  useEffect(() => {
    if (!server || fc.type !== 'date') return
    let cancelled = false
    fetchColumnStats(fc.datasetFileId, fetchColId)
      .then((s) => {
        if (!cancelled) setServerBounds(parseBounds(s.min as string, s.max as string))
      })
      .catch(() => { if (!cancelled) setServerBounds(null) })
    return () => { cancelled = true }
  }, [server, fc.type, fc.datasetFileId, fetchColId])

  return useMemo(() => {
    if (fc.type !== 'date') return null
    if (server) return serverBounds
    let lo: string | null = null
    let hi: string | null = null
    for (const row of rows) {
      const day = toDayBound(row[fc.columnId] as string)
      if (!day) continue
      if (lo == null || day < lo) lo = day
      if (hi == null || day > hi) hi = day
    }
    return parseBounds(lo, hi)
  }, [fc.type, fc.columnId, server, serverBounds, rows])
}

/** Filter control that sources its own row data (front-only rows or server-fetched
 *  values). Separate component so the data hook runs per control (not in a .map). */
export function FilterControlWithData({
  fc,
  value,
  onChange,
}: {
  fc: DashboardFilter
  value?: FilterValue
  onChange: (value: FilterValue) => void
}) {
  const rows = useFilterControlRows(fc)
  const dateBounds = useDateColumnBounds(fc, rows)
  return <FilterControl fc={fc} rows={rows} value={value} onChange={onChange} dateBounds={dateBounds} />
}

function FilterControl({
  fc,
  rows,
  value,
  onChange,
  dateBounds,
}: {
  fc: DashboardFilter
  rows: Record<string, unknown>[]
  value?: FilterValue
  onChange: (value: FilterValue) => void
  dateBounds?: DateBounds | null
}) {
  // Range inputs for numeric / date
  const isDateRange = fc.inputType === 'range' || fc.inputType === 'slider' || fc.inputType === 'slider-range'
  if (fc.type === 'date' && isDateRange) {
    return (
      <DateFilter
        value={value as (FilterValue & { type: 'date' | 'date-relative' }) | undefined}
        presets={fc.datePresets ?? []}
        onChange={onChange}
        bounds={dateBounds ?? null}
        withSlider={fc.inputType !== 'range'}
        withInputs={fc.inputType !== 'slider'}
      />
    )
  }
  if (fc.inputType === 'range') {
    return (
      <NumericFilter
        columnId={fc.columnId}
        rows={rows}
        value={value as (FilterValue & { type: 'numeric' }) | undefined}
        onChange={onChange}
      />
    )
  }

  if (fc.inputType === 'double-range') {
    return (
      <DoubleNumericFilter
        columnId={fc.columnId}
        rows={rows}
        value={value as (FilterValue & { type: 'numeric-double' }) | undefined}
        onChange={onChange}
      />
    )
  }

  // Discrete inputs (checkbox, multi-select, single-select) — works for any column type
  if (fc.inputType === 'checkbox') {
    return (
      <CategoricalCheckbox
        columnId={fc.columnId}
        rows={rows}
        value={value as (FilterValue & { type: 'categorical' }) | undefined}
        onChange={onChange}
      />
    )
  }
  if (fc.inputType === 'single-select') {
    return (
      <CategoricalSingleSelect
        columnId={fc.columnId}
        rows={rows}
        value={value as (FilterValue & { type: 'categorical' }) | undefined}
        onChange={onChange}
      />
    )
  }
  // Default: multi-select
  return (
    <CategoricalMultiSelect
      columnId={fc.columnId}
      rows={rows}
      value={value as (FilterValue & { type: 'categorical' }) | undefined}
      onChange={onChange}
    />
  )
}

// --- Categorical: Checkbox list ---

const CHECKBOX_WARN_THRESHOLD = 20
const DROPDOWN_WARN_THRESHOLD = 1000

/** Build a categorical FilterValue from a selection set:
 *  - all values selected  → [] (no restriction; handleFilterChange clears it → resets to default)
 *  - nothing selected     → [FILTER_NONE] sentinel (→ 0 results, distinct from "no filter")
 *  - some selected        → the explicit list */
function categoricalValue(selected: Set<string>, allValues: string[]): FilterValue {
  if (selected.size === 0) return { type: 'categorical', selected: [FILTER_NONE] }
  if (selected.size >= allValues.length && allValues.every((v) => selected.has(v))) {
    return { type: 'categorical', selected: [] }
  }
  return { type: 'categorical', selected: Array.from(selected) }
}

/** Read a stored categorical selection, treating the FILTER_NONE sentinel as an empty set. */
function readSelection(value?: { selected: string[] }): { selected: Set<string>; isNone: boolean } {
  const raw = value?.selected ?? []
  const isNone = raw.length === 1 && raw[0] === FILTER_NONE
  return { selected: new Set(isNone ? [] : raw), isNone }
}

function CategoricalCheckbox({
  columnId,
  rows,
  value,
  onChange,
}: {
  columnId: string
  rows: Record<string, unknown>[]
  value?: { type: 'categorical'; selected: string[] }
  onChange: (value: FilterValue) => void
}) {
  const { t } = useTranslation()

  const uniqueValues = useMemo(() => {
    const vals = new Set<string>()
    for (const row of rows) {
      const v = row[columnId]
      if (v != null && v !== '') vals.add(String(v))
    }
    return Array.from(vals).sort()
  }, [rows, columnId])

  // No active filter (value undefined) => everything is checked. The first toggle materializes
  // the full list, so the user can uncheck down to zero (→ no results, stored as FILTER_NONE).
  const isActive = value != null
  const { selected } = readSelection(value)

  const isChecked = (val: string) => (isActive ? selected.has(val) : true)

  const toggle = (val: string) => {
    const base = isActive ? new Set(selected) : new Set(uniqueValues)
    if (base.has(val)) base.delete(val)
    else base.add(val)
    onChange(categoricalValue(base, uniqueValues))
  }

  return (
    <div className="space-y-1">
      {uniqueValues.length > CHECKBOX_WARN_THRESHOLD && (
        <div className="flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5">
          <TriangleAlert size={11} className="shrink-0 text-amber-500 mt-0.5" />
          <span className="text-[10px] text-amber-700 dark:text-amber-400">
            {t('dashboard.filter_warn_checkbox', { count: uniqueValues.length })}
          </span>
        </div>
      )}
      <div className="space-y-0.5 max-h-32 overflow-y-auto">
        {uniqueValues.map((val) => (
          <label key={val} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent/50 rounded px-1 py-0.5">
            <Checkbox
              checked={isChecked(val)}
              onCheckedChange={() => toggle(val)}
              className="size-3.5 shrink-0 [&_svg]:size-3"
            />
            <span className="truncate leading-none">{val}</span>
          </label>
        ))}
        {uniqueValues.length === 0 && (
          <p className="text-[10px] text-muted-foreground italic">No values</p>
        )}
      </div>
      {isActive && (
        <Button
          variant="ghost"
          size="xs"
          className="text-xs h-5"
          onClick={() => onChange({ type: 'categorical', selected: [] })}
        >
          <X size={10} />
          Clear
        </Button>
      )}
    </div>
  )
}

// --- Categorical: Multi-select (popover with search + checkboxes) ---

function CategoricalMultiSelect({
  columnId,
  rows,
  value,
  onChange,
}: {
  columnId: string
  rows: Record<string, unknown>[]
  value?: { type: 'categorical'; selected: string[] }
  onChange: (value: FilterValue) => void
}) {
  const { t } = useTranslation()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [search, setSearch] = useState('')

  const uniqueValues = useMemo(() => {
    const vals = new Set<string>()
    for (const row of rows) {
      const v = row[columnId]
      if (v != null && v !== '') vals.add(String(v))
    }
    return Array.from(vals).sort()
  }, [rows, columnId])

  const filteredValues = useMemo(() => {
    if (!search) return uniqueValues
    const lower = search.toLowerCase()
    return uniqueValues.filter((v) => v.toLowerCase().includes(lower))
  }, [uniqueValues, search])

  // No active filter => all values implicitly selected. First toggle materializes the full
  // list so the user can deselect down to zero (→ no results), just like the checkbox mode.
  const isActive = value != null
  const { selected } = readSelection(value)
  const isChecked = (val: string) => (isActive ? selected.has(val) : true)

  const toggle = (val: string) => {
    const base = isActive ? new Set(selected) : new Set(uniqueValues)
    if (base.has(val)) base.delete(val)
    else base.add(val)
    onChange(categoricalValue(base, uniqueValues))
  }

  // Effective selection (a non-active filter means everything is selected).
  const effectiveSelected = isActive ? selected : new Set(uniqueValues)

  const selectAllFiltered = () => {
    const base = new Set(effectiveSelected)
    for (const v of filteredValues) base.add(v)
    onChange(categoricalValue(base, uniqueValues))
  }
  const selectNoneFiltered = () => {
    const base = new Set(effectiveSelected)
    for (const v of filteredValues) base.delete(v)
    onChange(categoricalValue(base, uniqueValues))
  }

  const label = !isActive
    ? t('dashboard.filter_all')
    : selected.size === 0
      ? t('dashboard.filter_none', 'None')
      : selected.size === 1
        ? Array.from(selected)[0]
        : `${selected.size} selected`

  return (
    <div className="space-y-1">
      {uniqueValues.length > DROPDOWN_WARN_THRESHOLD && (
        <div className="flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5">
          <TriangleAlert size={11} className="shrink-0 text-amber-500 mt-0.5" />
          <span className="text-[10px] text-amber-700 dark:text-amber-400">
            {t('dashboard.filter_warn_dropdown', { count: uniqueValues.length })}
          </span>
        </div>
      )}
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="xs" className="w-full justify-between text-xs font-normal h-7">
            <span className="truncate">{label}</span>
            <ChevronsUpDown size={10} className="shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2" align="start">
          <Input
            placeholder={t('common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs mb-2"
            autoFocus
          />
          {filteredValues.length > 0 && (
            <div className="mb-1 flex items-center gap-1 px-1.5">
              <button type="button" onClick={selectAllFiltered} className="text-[10px] text-muted-foreground hover:text-foreground">
                {t('common.select_all')}
              </button>
              <span className="text-[10px] text-muted-foreground">/</span>
              <button type="button" onClick={selectNoneFiltered} className="text-[10px] text-muted-foreground hover:text-foreground">
                {t('common.select_none')}
              </button>
            </div>
          )}
          <TooltipProvider delayDuration={400}>
            <div
              className="max-h-40 space-y-0.5 overflow-y-auto overscroll-contain"
              onWheel={(e) => { e.stopPropagation(); e.currentTarget.scrollTop += e.deltaY }}
            >
              {filteredValues.map((val) => (
                <Tooltip key={val}>
                  <TooltipTrigger asChild>
                    <label className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent/50 rounded px-1.5 py-1">
                      <Checkbox
                        checked={isChecked(val)}
                        onCheckedChange={() => toggle(val)}
                        className="size-3.5 shrink-0 [&_svg]:size-3"
                      />
                      <span className="truncate">{val}</span>
                    </label>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-64">{val}</TooltipContent>
                </Tooltip>
              ))}
              {filteredValues.length === 0 && (
                <p className="text-[10px] text-muted-foreground italic text-center py-2">{t('common.no_results')}</p>
              )}
            </div>
          </TooltipProvider>
        </PopoverContent>
      </Popover>
      {isActive && (
        <Button
          variant="ghost"
          size="xs"
          className="text-xs h-5"
          onClick={() => onChange({ type: 'categorical', selected: [] })}
        >
          <X size={10} />
          Clear
        </Button>
      )}
    </div>
  )
}

// --- Categorical: Single-select dropdown ---

function CategoricalSingleSelect({
  columnId,
  rows,
  value,
  onChange,
}: {
  columnId: string
  rows: Record<string, unknown>[]
  value?: { type: 'categorical'; selected: string[] }
  onChange: (value: FilterValue) => void
}) {
  const { t } = useTranslation()

  const uniqueValues = useMemo(() => {
    const vals = new Set<string>()
    for (const row of rows) {
      const v = row[columnId]
      if (v != null && v !== '') vals.add(String(v))
    }
    return Array.from(vals).sort()
  }, [rows, columnId])

  const currentValue = value?.selected?.[0] ?? '__all__'

  return (
    <div className="space-y-1">
      {uniqueValues.length > DROPDOWN_WARN_THRESHOLD && (
        <div className="flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5">
          <TriangleAlert size={11} className="shrink-0 text-amber-500 mt-0.5" />
          <span className="text-[10px] text-amber-700 dark:text-amber-400">
            {t('dashboard.filter_warn_dropdown', { count: uniqueValues.length })}
          </span>
        </div>
      )}
    <Select
      value={currentValue}
      onValueChange={(v) => {
        if (v === '__all__') {
          onChange({ type: 'categorical', selected: [] })
        } else {
          onChange({ type: 'categorical', selected: [v] })
        }
      }}
    >
      <SelectTrigger className="h-7 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" sideOffset={4}>
        <SelectItem value="__all__" className="text-xs">{t('dashboard.filter_all')}</SelectItem>
        {uniqueValues.map((val) => (
          <SelectItem key={val} value={val} className="text-xs">{val}</SelectItem>
        ))}
      </SelectContent>
    </Select>
    </div>
  )
}

// --- Numeric Filter ---

function NumericFilter({
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

function DoubleNumericFilter({
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

function DateFilter({
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
function FilterScopeBadge({
  scope,
  tabs,
  widgets,
}: {
  scope: DashboardFilterScope
  tabs: DashboardTab[]
  widgets: DashboardWidget[]
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const isAll = scope.type === 'all'

  const targetNames = useMemo(() => {
    if (scope.type === 'tabs') {
      const ids = new Set(scope.tabIds)
      return tabs.filter(tb => ids.has(tb.id)).map(tb => localized(tb.name, lang))
    }
    if (scope.type === 'widgets') {
      const ids = new Set(scope.widgetIds)
      return widgets.filter(w => ids.has(w.id)).map(w => localized(w.name, lang))
    }
    return []
  }, [scope, tabs, widgets, lang])

  const label = scope.type === 'all'
    ? t('dashboard.filter_scope_all')
    : scope.type === 'tabs'
      ? t('dashboard.filter_scope_tabs_count', { count: targetNames.length })
      : t('dashboard.filter_scope_widgets_count', { count: targetNames.length })

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium',
              isAll
                ? 'bg-muted text-muted-foreground'
                : 'bg-muted text-foreground/70 ring-1 ring-inset ring-border',
            )}
          >
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-h-72 max-w-64 overflow-y-auto bg-foreground text-background">
          <p className="mb-1 text-[11px] font-semibold">{t('dashboard.filter_scope')}</p>
          {isAll ? (
            <p className="text-[11px]">{t('dashboard.filter_scope_all_hint')}</p>
          ) : (
            <ul className="ml-1 list-inside list-disc">
              {targetNames.slice(0, 12).map((name, i) => (
                <li key={i} className="text-[11px] font-medium">{name}</li>
              ))}
              {targetNames.length > 12 && (
                <li className="list-none text-[11px] text-background/70">
                  {t('dashboard.filter_values_more', { count: targetNames.length - 12 })}
                </li>
              )}
            </ul>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
