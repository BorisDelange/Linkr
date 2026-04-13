import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus, Database, ArrowRightLeft, ChevronsUpDown, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Dashboard, DashboardFilter, DashboardFilterScope, DashboardWidget, FilterValue } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'

interface DashboardFilterSidebarProps {
  dashboard: Dashboard
  widgets: DashboardWidget[]
  tabs: { id: string; name: string }[]
  editMode: boolean
  onClose: () => void
}

let filterIdCounter = 0

export function DashboardFilterSidebar({ dashboard, widgets, tabs, editMode, onClose }: DashboardFilterSidebarProps) {
  const { t } = useTranslation()
  const { activeFilters, setFilter, clearFilter, clearAllFilters, updateDashboard } = useDashboardStore()
  const { files: datasetFiles, getFileRows } = useDatasetStore()

  // "Add filter" flow state
  const [addingFilter, setAddingFilter] = useState(false)
  const [newFilterDatasetId, setNewFilterDatasetId] = useState<string | null>(null)
  const [newFilterColumnId, setNewFilterColumnId] = useState<string | null>(null)
  const [newFilterInputType, setNewFilterInputType] = useState<DashboardFilter['inputType']>('multi-select')

  // Collect unique dataset IDs used by widgets
  const widgetDatasetIds = useMemo(() => {
    const ids = new Set<string>()
    for (const w of widgets) {
      if (w.datasetFileId) ids.add(w.datasetFileId)
    }
    return ids
  }, [widgets])

  const availableDatasets = useMemo(
    () => datasetFiles.filter((f) => widgetDatasetIds.has(f.id)),
    [datasetFiles, widgetDatasetIds]
  )

  const newFilterDataset = newFilterDatasetId ? datasetFiles.find((f) => f.id === newFilterDatasetId) : null
  const newFilterColumns = newFilterDataset?.columns ?? []

  const resetAddFlow = () => {
    setAddingFilter(false)
    setNewFilterDatasetId(null)
    setNewFilterColumnId(null)
    setNewFilterInputType('multi-select')
  }

  // Auto-detect column type and pick default inputType
  const detectDefaults = (columnId: string) => {
    const col = newFilterColumns.find((c) => c.id === columnId)
    if (!col) return { type: 'categorical' as const, inputType: 'multi-select' as const }

    if (col.type === 'number') return { type: 'numeric' as const, inputType: 'range' as const }
    if (col.type === 'date') return { type: 'date' as const, inputType: 'range' as const }
    return { type: 'categorical' as const, inputType: 'multi-select' as const }
  }

  const handleColumnChange = (columnId: string) => {
    setNewFilterColumnId(columnId)
    const { inputType } = detectDefaults(columnId)
    setNewFilterInputType(inputType)
  }

  const handleAddFilter = () => {
    if (!newFilterDatasetId || !newFilterColumnId) return
    const col = newFilterColumns.find((c) => c.id === newFilterColumnId)
    if (!col) return

    const { type } = detectDefaults(newFilterColumnId)

    const newFilter: DashboardFilter = {
      id: `df-${Date.now()}-${filterIdCounter++}`,
      datasetFileId: newFilterDatasetId,
      columnId: newFilterColumnId,
      columnName: col.name,
      type,
      inputType: newFilterInputType,
      propagate: false,
    }

    updateDashboard(dashboard.id, {
      filterConfig: [...dashboard.filterConfig, newFilter],
    })
    resetAddFlow()
  }

  const handleRemoveFilter = (filterId: string) => {
    updateDashboard(dashboard.id, {
      filterConfig: dashboard.filterConfig.filter((f) => f.id !== filterId),
    })
    clearFilter(filterId)
  }

  const handleTogglePropagate = (filterId: string, propagate: boolean) => {
    updateDashboard(dashboard.id, {
      filterConfig: dashboard.filterConfig.map((f) =>
        f.id === filterId ? { ...f, propagate } : f
      ),
    })
  }

  const handleScopeChange = (filterId: string, scope: DashboardFilterScope) => {
    updateDashboard(dashboard.id, {
      filterConfig: dashboard.filterConfig.map((f) =>
        f.id === filterId ? { ...f, scope } : f
      ),
    })
  }

  const handleChangeInputType = (filterId: string, inputType: DashboardFilter['inputType']) => {
    updateDashboard(dashboard.id, {
      filterConfig: dashboard.filterConfig.map((f) =>
        f.id === filterId ? { ...f, inputType } : f
      ),
    })
    // Clear the active filter value since input type changed
    clearFilter(filterId)
  }

  const handleFilterChange = (filterId: string, value: FilterValue) => {
    setFilter(filterId, value)
  }

  const handleClearAll = () => {
    clearAllFilters()
  }

  const activeFilterCount = Object.keys(activeFilters).length

  // Available inputType options per filter type
  const getInputTypeOptions = (filterType: DashboardFilter['type']) => {
    const options: { value: DashboardFilter['inputType']; label: string }[] = [
      { value: 'checkbox', label: t('dashboard.input_type_checkbox') },
      { value: 'multi-select', label: t('dashboard.input_type_multi_select') },
      { value: 'single-select', label: t('dashboard.input_type_single_select') },
    ]
    if (filterType === 'numeric' || filterType === 'date') {
      options.push({ value: 'range', label: t('dashboard.input_type_range') })
    }
    return options
  }

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-l bg-background">
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <span className="text-sm font-semibold">{t('dashboard.filter_title')}</span>
        <div className="flex items-center gap-1">
          {activeFilterCount > 0 && (
            <Button variant="ghost" size="xs" onClick={handleClearAll}>
              {t('dashboard.filter_clear_all')}
            </Button>
          )}
          <Button variant="ghost" size="icon-xs" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
          <div className="p-4 space-y-4">
            {dashboard.filterConfig.length === 0 && !addingFilter && (
              <p className="text-xs text-muted-foreground">
                {t('dashboard.filter_no_columns')}
              </p>
            )}

            {dashboard.filterConfig.map((fc) => {
              const dsFile = datasetFiles.find((f) => f.id === fc.datasetFileId)
              const rows = getFileRows(fc.datasetFileId)
              const inputTypeOptions = getInputTypeOptions(fc.type)

              return (
                <div key={fc.id} className="space-y-2 rounded-lg border p-3">
                  {/* Header: column name + remove button */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate flex-1">{fc.columnName}</span>
                    {editMode && (
                      <Button variant="ghost" size="icon-xs" onClick={() => handleRemoveFilter(fc.id)}>
                        <X size={12} />
                      </Button>
                    )}
                  </div>

                  {/* Edit mode only: dataset badge, input type selector, propagate toggle */}
                  {editMode && (
                    <div className="space-y-2">
                      <Badge variant="secondary" className="text-[10px] gap-1">
                        <Database size={9} />
                        {dsFile?.name ?? '?'}
                      </Badge>

                      {/* Input type selector — only if multiple options */}
                      {inputTypeOptions.length > 1 && (
                        <Select
                          value={fc.inputType}
                          onValueChange={(v) => handleChangeInputType(fc.id, v as DashboardFilter['inputType'])}
                        >
                          <SelectTrigger className="h-6 text-[10px] w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent position="popper" sideOffset={4}>
                            {inputTypeOptions.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value} className="text-xs">
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}

                      {/* Propagate toggle */}
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={fc.propagate}
                          onCheckedChange={(v) => handleTogglePropagate(fc.id, v)}
                          className="scale-75 origin-left"
                        />
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <ArrowRightLeft size={9} />
                          {t('dashboard.filter_propagate')}
                        </span>
                      </div>

                      {/* Scope selector */}
                      <FilterScopeSelector
                        scope={fc.scope ?? { type: 'all' }}
                        onChange={(scope) => handleScopeChange(fc.id, scope)}
                        tabs={tabs}
                        widgets={widgets}
                      />
                    </div>
                  )}

                  {/* Filter control */}
                  <FilterControl
                    fc={fc}
                    rows={rows}
                    value={activeFilters[fc.id]}
                    onChange={(v) => handleFilterChange(fc.id, v)}
                  />
                </div>
              )
            })}

            {/* Add filter flow — edit mode only */}
            {editMode && (
              addingFilter ? (
                <div className="space-y-2 rounded-lg border border-dashed p-3">
                  <Label className="text-xs font-medium">{t('dashboard.filter_select_dataset')}</Label>
                  <Select
                    value={newFilterDatasetId ?? ''}
                    onValueChange={(v) => {
                      setNewFilterDatasetId(v)
                      setNewFilterColumnId(null)
                    }}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue placeholder={t('dashboard.filter_select_dataset')} />
                    </SelectTrigger>
                    <SelectContent position="popper" sideOffset={4}>
                      {availableDatasets.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          <div className="flex items-center gap-2">
                            <Database size={11} className="text-muted-foreground" />
                            {f.name}
                          </div>
                        </SelectItem>
                      ))}
                      {availableDatasets.length === 0 && (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          {t('dashboard.filter_no_datasets')}
                        </div>
                      )}
                    </SelectContent>
                  </Select>

                  {newFilterDatasetId && (
                    <>
                      <Label className="text-xs font-medium">{t('dashboard.filter_select_column')}</Label>
                      <Select
                        value={newFilterColumnId ?? ''}
                        onValueChange={handleColumnChange}
                      >
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue placeholder={t('dashboard.filter_select_column')} />
                        </SelectTrigger>
                        <SelectContent position="popper" sideOffset={4}>
                          {newFilterColumns.map((c) => (
                            <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </>
                  )}

                  {newFilterColumnId && (
                    <>
                      <Label className="text-xs font-medium">{t('dashboard.filter_input_type')}</Label>
                      <Select
                        value={newFilterInputType}
                        onValueChange={(v) => setNewFilterInputType(v as DashboardFilter['inputType'])}
                      >
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" sideOffset={4}>
                          {getInputTypeOptions(detectDefaults(newFilterColumnId).type).map((opt) => (
                            <SelectItem key={opt.value} value={opt.value} className="text-xs">
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </>
                  )}

                  <div className="flex gap-1.5 pt-1">
                    <Button variant="outline" size="xs" onClick={resetAddFlow}>
                      {t('common.cancel')}
                    </Button>
                    <Button size="xs" onClick={handleAddFilter} disabled={!newFilterColumnId}>
                      {t('common.add')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-1.5 text-xs text-muted-foreground"
                  onClick={() => setAddingFilter(true)}
                >
                  <Plus size={12} />
                  {t('dashboard.filter_add')}
                </Button>
              )
            )}
          </div>
        </ScrollArea>
    </div>
  )
}

// --- Filter control dispatcher ---

function FilterControl({
  fc,
  rows,
  value,
  onChange,
}: {
  fc: DashboardFilter
  rows: Record<string, unknown>[]
  value?: FilterValue
  onChange: (value: FilterValue) => void
}) {
  // Range inputs for numeric / date
  if (fc.inputType === 'range') {
    if (fc.type === 'date') {
      return (
        <DateFilter
          value={value as (FilterValue & { type: 'date' }) | undefined}
          onChange={onChange}
        />
      )
    }
    return (
      <NumericFilter
        columnId={fc.columnId}
        rows={rows}
        value={value as (FilterValue & { type: 'numeric' }) | undefined}
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

  const selected = new Set(value?.selected ?? [])
  const allSelected = selected.size === 0

  const toggle = (val: string) => {
    const next = new Set(selected)
    if (next.has(val)) next.delete(val)
    else next.add(val)
    onChange({ type: 'categorical', selected: Array.from(next) })
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
              checked={allSelected || selected.has(val)}
              onCheckedChange={() => toggle(val)}
              className="h-3 w-3"
            />
            <span className="truncate">{val}</span>
          </label>
        ))}
        {uniqueValues.length === 0 && (
          <p className="text-[10px] text-muted-foreground italic">No values</p>
        )}
      </div>
      {selected.size > 0 && (
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

  const selected = new Set(value?.selected ?? [])

  const toggle = (val: string) => {
    const next = new Set(selected)
    if (next.has(val)) next.delete(val)
    else next.add(val)
    onChange({ type: 'categorical', selected: Array.from(next) })
  }

  const label = selected.size === 0
    ? t('dashboard.filter_all')
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
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {filteredValues.map((val) => (
              <label key={val} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent/50 rounded px-1.5 py-1">
                <Checkbox
                  checked={selected.has(val)}
                  onCheckedChange={() => toggle(val)}
                  className="h-3 w-3"
                />
                <span className="truncate">{val}</span>
              </label>
            ))}
            {filteredValues.length === 0 && (
              <p className="text-[10px] text-muted-foreground italic text-center py-2">No values</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {selected.size > 0 && (
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
        <span className="text-[10px] text-muted-foreground">Min ({range.min})</span>
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
        <span className="text-[10px] text-muted-foreground">Max ({range.max})</span>
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

// --- Date Filter ---

function DateFilter({
  value,
  onChange,
}: {
  value?: { type: 'date'; from: string | null; to: string | null }
  onChange: (value: FilterValue) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="space-y-0.5">
        <span className="text-[10px] text-muted-foreground">From</span>
        <Input
          type="date"
          className="h-6 text-xs"
          value={value?.from ?? ''}
          onChange={(e) => {
            onChange({ type: 'date', from: e.target.value || null, to: value?.to ?? null })
          }}
        />
      </div>
      <div className="space-y-0.5">
        <span className="text-[10px] text-muted-foreground">To</span>
        <Input
          type="date"
          className="h-6 text-xs"
          value={value?.to ?? ''}
          onChange={(e) => {
            onChange({ type: 'date', from: value?.from ?? null, to: e.target.value || null })
          }}
        />
      </div>
    </div>
  )
}

// --- Filter Scope Selector ---

function FilterScopeSelector({
  scope,
  onChange,
  tabs,
  widgets,
}: {
  scope: DashboardFilterScope
  onChange: (scope: DashboardFilterScope) => void
  tabs: { id: string; name: string }[]
  widgets: DashboardWidget[]
}) {
  const { t } = useTranslation()
  const [popoverOpen, setPopoverOpen] = useState(false)

  // Build widget options grouped by tab
  const widgetOptions = useMemo(() => {
    const result: { tabName: string; widgetId: string; widgetName: string }[] = []
    for (const tab of tabs) {
      const tabWidgets = widgets.filter(w => w.tabId === tab.id)
      for (const w of tabWidgets) {
        result.push({ tabName: tab.name, widgetId: w.id, widgetName: w.name })
      }
    }
    return result
  }, [tabs, widgets])

  const scopeType = scope.type

  const scopeLabel = scopeType === 'all'
    ? t('dashboard.filter_scope_all')
    : scopeType === 'tabs'
      ? t('dashboard.filter_scope_tabs_count', { count: (scope as { tabIds: string[] }).tabIds.length })
      : t('dashboard.filter_scope_widgets_count', { count: (scope as { widgetIds: string[] }).widgetIds.length })

  return (
    <div className="space-y-1">
      <span className="text-[10px] text-muted-foreground">{t('dashboard.filter_scope')}</span>
      <Select
        value={scopeType}
        onValueChange={(v) => {
          if (v === 'all') onChange({ type: 'all' })
          else if (v === 'tabs') onChange({ type: 'tabs', tabIds: tabs.map(tab => tab.id) })
          else if (v === 'widgets') onChange({ type: 'widgets', widgetIds: widgets.map(w => w.id) })
        }}
      >
        <SelectTrigger className="h-6 text-[10px] w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" sideOffset={4}>
          <SelectItem value="all" className="text-xs">{t('dashboard.filter_scope_all')}</SelectItem>
          <SelectItem value="tabs" className="text-xs">{t('dashboard.filter_scope_tabs')}</SelectItem>
          <SelectItem value="widgets" className="text-xs">{t('dashboard.filter_scope_widgets')}</SelectItem>
        </SelectContent>
      </Select>

      {/* Tab selection */}
      {scopeType === 'tabs' && (
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="xs" className="w-full justify-between text-[10px] font-normal h-6">
              <span className="truncate">{scopeLabel}</span>
              <ChevronsUpDown size={9} className="shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-52 p-2" align="start">
            <div className="max-h-40 overflow-y-auto space-y-0.5">
              {tabs.map((tab) => {
                const selected = (scope as { tabIds: string[] }).tabIds.includes(tab.id)
                return (
                  <label key={tab.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent/50 rounded px-1.5 py-1">
                    <Checkbox
                      checked={selected}
                      onCheckedChange={() => {
                        const current = (scope as { tabIds: string[] }).tabIds
                        const next = selected ? current.filter(id => id !== tab.id) : [...current, tab.id]
                        if (next.length > 0) onChange({ type: 'tabs', tabIds: next })
                      }}
                      className="h-3 w-3"
                    />
                    <span className="truncate">{tab.name}</span>
                  </label>
                )
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {/* Widget selection */}
      {scopeType === 'widgets' && (
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="xs" className="w-full justify-between text-[10px] font-normal h-6">
              <span className="truncate">{scopeLabel}</span>
              <ChevronsUpDown size={9} className="shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-2" align="start">
            <div className="max-h-48 overflow-y-auto space-y-0.5">
              {widgetOptions.map(({ tabName, widgetId, widgetName }) => {
                const selected = (scope as { widgetIds: string[] }).widgetIds.includes(widgetId)
                return (
                  <label key={widgetId} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent/50 rounded px-1.5 py-1">
                    <Checkbox
                      checked={selected}
                      onCheckedChange={() => {
                        const current = (scope as { widgetIds: string[] }).widgetIds
                        const next = selected ? current.filter(id => id !== widgetId) : [...current, widgetId]
                        if (next.length > 0) onChange({ type: 'widgets', widgetIds: next })
                      }}
                      className="h-3 w-3"
                    />
                    <span className="truncate text-muted-foreground">{tabName}</span>
                    <span className="text-[10px] text-muted-foreground/60">›</span>
                    <span className="truncate">{widgetName}</span>
                  </label>
                )
              })}
              {widgetOptions.length === 0 && (
                <p className="text-[10px] text-muted-foreground italic text-center py-2">
                  {t('dashboard.filter_no_widgets')}
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
