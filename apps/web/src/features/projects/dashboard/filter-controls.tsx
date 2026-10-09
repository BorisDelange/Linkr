import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { parseBounds, toDayBound, type DateBounds } from './date-slider'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { DashboardFilter, DashboardFilterScope, DashboardTab, DashboardWidget, FilterValue } from '@/types'
import { localized } from '@/lib/localized'
import { useDatasetStore } from '@/stores/dataset-store'
import { isServerMode } from '@/lib/api-client'
import { fetchColumnDistinct, fetchColumnStats } from '@/lib/api/datasets'
import { isEmptyFilterValue } from './filter-value'
import { CategoricalCheckbox, CategoricalMultiSelect, CategoricalSingleSelect } from './filter-categorical-controls'
import { NumericFilter, DoubleNumericFilter, DateFilter } from './filter-range-controls'

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
          <p className="mb-1 text-xs font-semibold">{t('dashboard.filter_scope')}</p>
          {isAll ? (
            <p className="text-xs">{t('dashboard.filter_scope_all_hint')}</p>
          ) : (
            <ul className="ml-1 list-inside list-disc">
              {targetNames.slice(0, 12).map((name, i) => (
                <li key={i} className="text-xs font-medium">{name}</li>
              ))}
              {targetNames.length > 12 && (
                <li className="list-none text-xs text-background/70">
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
