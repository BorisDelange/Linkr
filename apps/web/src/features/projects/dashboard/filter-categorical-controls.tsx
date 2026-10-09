import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X, ChevronsUpDown, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { FilterValue } from '@/types'
import { FILTER_NONE } from './DashboardDataProvider'

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

export function CategoricalCheckbox({
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

export function CategoricalMultiSelect({
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

export function CategoricalSingleSelect({
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
