import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus, Database, ChevronsUpDown, ChevronRight, TriangleAlert } from 'lucide-react'
import { SearchInput } from '@/components/ui/search-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DatePickerField } from '@/components/ui/date-picker-field'
import { Label } from '@/components/ui/label'
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { Dashboard, DashboardFilter, DashboardFilterScope, DashboardTab, DashboardWidget, DatasetColumn, DatePreset, DatePresetUnit, FilterValue } from '@/types'
import { localized, setLocalized } from '@/lib/localized'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { isServerMode } from '@/lib/api-client'
import { fetchColumnDistinct, fetchColumnStats } from '@/lib/api/datasets'
import { presetLabel } from './date-presets'
import { FILTER_NONE } from './DashboardDataProvider'

/** Filter cards start collapsed to keep the sidebar compact. */
const DEFAULT_FILTER_OPEN = false

/** Map a dataset column's type to the filter's type + default input widget. */
function detectColumnDefaults(col: DatasetColumn | undefined): {
  type: DashboardFilter['type']
  inputType: DashboardFilter['inputType']
} {
  if (col?.type === 'number') return { type: 'numeric', inputType: 'range' }
  if (col?.type === 'date') return { type: 'date', inputType: 'range' }
  return { type: 'categorical', inputType: 'multi-select' }
}

interface DashboardFilterSidebarProps {
  dashboard: Dashboard
  widgets: DashboardWidget[]
  tabs: DashboardTab[]
  editMode: boolean
  onClose: () => void
}


export function DashboardFilterSidebar({ dashboard, widgets, tabs, editMode, onClose }: DashboardFilterSidebarProps) {
  const { t, i18n } = useTranslation()
  const language = i18n.language as 'en' | 'fr'
  const { activeFilters, setFilter, clearFilter, clearAllFilters, updateDashboard } = useDashboardStore()
  const { files: datasetFiles } = useDatasetStore()

  // Resizable sidebar width (drag the left edge). Default a bit wider so date From/To fields aren't clipped.
  const [width, setWidth] = useState(340)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startW: width }
  }
  const onResizeMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    // Dragging left (smaller clientX) widens the right-anchored sidebar.
    const delta = dragRef.current.startX - e.clientX
    setWidth(Math.max(260, Math.min(640, dragRef.current.startW + delta)))
  }
  const onResizeUp = (e: React.PointerEvent) => {
    dragRef.current = null
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }

  // Which filter cards are expanded (collapsed by default to save space).
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpanded = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  // Reset per-card open/closed overrides when switching modes (defaults differ: open out of edit, closed in edit).
  useEffect(() => { setExpanded(new Set()) }, [editMode])

  // The `expanded` set flips each card from the collapsed default. So "collapse all" clears it
  // and "expand all" adds every filter id.
  const setAllExpanded = (open: boolean) => {
    setExpanded(open === DEFAULT_FILTER_OPEN ? new Set() : new Set(dashboard.filterConfig.map(fc => fc.id)))
  }

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
  const detectDefaults = (columnId: string) =>
    detectColumnDefaults(newFilterColumns.find((c) => c.id === columnId))

  const handleColumnChange = (columnId: string) => {
    setNewFilterColumnId(columnId)
    const { inputType } = detectDefaults(columnId)
    setNewFilterInputType(inputType)
  }

  // Change the column of an EXISTING filter (edit mode). Re-derives type + input widget from
  // the new column and clears any active value, since it no longer applies to the new column.
  const handleFilterColumnChange = (filterId: string, columnId: string) => {
    const filter = dashboard.filterConfig.find((f) => f.id === filterId)
    if (!filter) return
    const cols = datasetFiles.find((f) => f.id === filter.datasetFileId)?.columns ?? []
    const col = cols.find((c) => c.id === columnId)
    if (!col) return
    const { type, inputType } = detectColumnDefaults(col)
    updateDashboard(dashboard.id, {
      filterConfig: dashboard.filterConfig.map((f) =>
        f.id === filterId ? { ...f, columnId: col.id, columnName: col.name, type, inputType } : f
      ),
    })
    clearFilter(filterId)
  }

  const handleAddFilter = () => {
    if (!newFilterDatasetId || !newFilterColumnId) return
    const col = newFilterColumns.find((c) => c.id === newFilterColumnId)
    if (!col) return

    const { type } = detectDefaults(newFilterColumnId)

    const newFilter: DashboardFilter = {
      id: crypto.randomUUID(),
      datasetFileId: newFilterDatasetId,
      columnId: newFilterColumnId,
      columnName: col.name,
      type,
      inputType: newFilterInputType,
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

  const handleDatePresetsChange = (filterId: string, datePresets: DashboardFilter['datePresets']) => {
    updateDashboard(dashboard.id, {
      filterConfig: dashboard.filterConfig.map((f) =>
        f.id === filterId ? { ...f, datePresets } : f
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

  const handleLabelChange = (filterId: string, label: string) => {
    const trimmed = label.trim()
    updateDashboard(dashboard.id, {
      filterConfig: dashboard.filterConfig.map((f) => {
        if (f.id !== filterId) return f
        // Edit only the active language, merged into the {en,fr} object (same convention as
        // tab/widget names). Drop the label entirely once no language holds a value.
        const next = setLocalized(f.label, language, trimmed)
        const hasAny = Object.values(next).some((v) => v.trim().length > 0)
        return { ...f, label: hasAny ? next : undefined }
      }),
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

  // An "empty" value (Clear pressed, no selection, no bounds) does nothing, so remove the
  // filter entirely — otherwise the active dot lingers and it counts as active.
  // For categorical, selected=[] means "all pass" (see applyFilters), i.e. no active filter.
  const isEmptyFilterValue = (value: FilterValue): boolean => {
    switch (value.type) {
      case 'categorical': return value.selected.length === 0
      case 'numeric': return value.min == null && value.max == null
      case 'numeric-double':
        return value.min1 == null && value.max1 == null && value.min2 == null && value.max2 == null
      case 'date': return value.from == null && value.to == null
      case 'date-relative': return false
    }
  }

  const handleFilterChange = (filterId: string, value: FilterValue) => {
    if (isEmptyFilterValue(value)) clearFilter(filterId)
    else setFilter(filterId, value)
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
    if (filterType === 'numeric') {
      options.push({ value: 'double-range', label: t('dashboard.input_type_double_range') })
    }
    return options
  }

  return (
    <div className="relative flex h-full shrink-0 flex-col border-l bg-background" style={{ width }}>
      {/* Drag handle on the left edge to resize the sidebar. */}
      <div
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        className="absolute left-0 top-0 z-10 h-full w-1 -translate-x-1/2 cursor-col-resize hover:bg-primary/30"
      />
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <span className="text-sm font-semibold">{t('dashboard.filter_title')}</span>
        <div className="flex items-center gap-1">
          {dashboard.filterConfig.length > 1 && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <button type="button" onClick={() => setAllExpanded(true)} className="hover:text-foreground">
                {t('dashboard.filter_expand_all')}
              </button>
              <span className="text-muted-foreground/40">/</span>
              <button type="button" onClick={() => setAllExpanded(false)} className="hover:text-foreground">
                {t('dashboard.filter_collapse_all')}
              </button>
            </div>
          )}
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
              const inputTypeOptions = getInputTypeOptions(fc.type)
              // A legacy filter's stored columnId can be stale; resolve the current one by name
              // so the column picker highlights the right column (same by-name matching as runtime).
              const currentColumnId = (dsFile?.columns ?? []).find((c) => c.name === fc.columnName)?.id ?? fc.columnId
              // Filters are collapsed by default to save space; the `expanded` set flips that.
              const toggled = expanded.has(fc.id)
              const isOpen = toggled ? !DEFAULT_FILTER_OPEN : DEFAULT_FILTER_OPEN
              const isActive = !!activeFilters[fc.id]

              return (
                <div
                  key={fc.id}
                  className={cn(
                    'rounded-lg border transition-colors',
                    isActive && 'border-green-500/40 bg-green-500/5',
                  )}
                >
                  {/* Collapsible header. Fixed height so toggling edit mode (which swaps the scope
                      badge for a taller remove button) doesn't change the collapsed row height. */}
                  <div className="flex h-9 items-center gap-1.5 px-2.5">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(fc.id)}
                      className="flex h-full flex-1 items-center gap-1.5 min-w-0 text-left"
                    >
                      <ChevronRight size={13} className={cn('shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                      <span className="text-xs font-medium truncate">{localized(fc.label, language) || fc.columnName}</span>
                    </button>
                    {!editMode && <FilterScopeBadge scope={fc.scope ?? { type: 'all' }} tabs={tabs} widgets={widgets} />}
                    {editMode && (
                      <Button variant="ghost" size="icon-xs" className="-mr-1 shrink-0" onClick={() => handleRemoveFilter(fc.id)}>
                        <X size={12} />
                      </Button>
                    )}
                  </div>

                  {isOpen && (
                    <div className="space-y-2 px-2.5 pb-2.5">
                      {editMode && (
                        <div className="space-y-2">
                          <Badge variant="secondary" className="gap-1">
                            <Database size={9} />
                            {dsFile?.name ?? '?'}
                          </Badge>

                          {/* Column selector — let the user re-point an existing filter to another column. */}
                          <div className="space-y-1">
                            <Label className="text-[10px] font-medium text-muted-foreground">{t('dashboard.filter_select_column')}</Label>
                            <ColumnPicker
                              columns={dsFile?.columns ?? []}
                              value={currentColumnId}
                              onChange={(columnId) => handleFilterColumnChange(fc.id, columnId)}
                              placeholder={t('dashboard.filter_select_column')}
                            />
                          </div>

                          {/* Optional display label — shown instead of the column name everywhere.
                              Multilingual: only the active UI language is edited here. */}
                          <div className="space-y-1">
                            <Label className="text-[10px] font-medium text-muted-foreground">{t('dashboard.filter_label', 'Label')}</Label>
                            <Input
                              key={`${fc.id}-${language}`}
                              defaultValue={localized(fc.label, language)}
                              placeholder={fc.columnName}
                              onBlur={(e) => handleLabelChange(fc.id, e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                              className="h-7 text-xs"
                            />
                          </div>

                          {/* Scope selector — before the input-type dropdown (renders its own label) */}
                          <FilterScopeSelector
                            scope={fc.scope ?? { type: 'all' }}
                            onChange={(scope) => handleScopeChange(fc.id, scope)}
                            tabs={tabs}
                            widgets={widgets}
                          />
                          {inputTypeOptions.length > 1 && (
                            <div className="space-y-1">
                              <Label className="text-[10px] font-medium text-muted-foreground">{t('dashboard.filter_input_type', 'Filter type')}</Label>
                              <Select
                                value={fc.inputType}
                                onValueChange={(v) => handleChangeInputType(fc.id, v as DashboardFilter['inputType'])}
                              >
                                <SelectTrigger className="h-7 text-xs w-full">
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
                            </div>
                          )}
                          {fc.type === 'date' && (
                            <DatePresetEditor
                              presets={fc.datePresets ?? []}
                              onChange={(p) => handleDatePresetsChange(fc.id, p)}
                            />
                          )}
                        </div>
                      )}

                      {/* Filter control — hidden in edit mode (no live preview while configuring) */}
                      {!editMode && (
                        <FilterControlWithData
                          fc={fc}
                          value={activeFilters[fc.id]}
                          onChange={(v) => handleFilterChange(fc.id, v)}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Add filter flow — edit mode only */}
            {editMode && (
              addingFilter ? (
                <div className="space-y-2 rounded-lg border border-dashed p-3">
                  <Label>{t('dashboard.filter_select_dataset')}</Label>
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
                      <Label>{t('dashboard.filter_select_column')}</Label>
                      <ColumnPicker
                        columns={newFilterColumns}
                        value={newFilterColumnId}
                        onChange={handleColumnChange}
                        placeholder={t('dashboard.filter_select_column')}
                      />
                    </>
                  )}

                  {newFilterColumnId && (
                    <>
                      <Label>{t('dashboard.filter_input_type')}</Label>
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

/** Searchable column dropdown, shared by the add-filter flow and the per-filter edit block.
 *  Manages its own open/search state so multiple instances stay independent. */
function ColumnPicker({
  columns,
  value,
  onChange,
  placeholder,
}: {
  columns: DatasetColumn[]
  value: string | null
  onChange: (columnId: string) => void
  placeholder: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = columns.find((c) => c.id === value)
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? columns.filter((c) => c.name.toLowerCase().includes(q)) : columns
  }, [columns, search])

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch('') }}>
      <PopoverTrigger asChild>
        <button className="flex h-7 w-full items-center justify-between rounded-md border px-3 text-xs hover:bg-accent/50 transition-colors">
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.name : placeholder}
          </span>
          <ChevronsUpDown size={12} className="ml-1 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2 bg-popover" align="start">
        {columns.length > 5 && (
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('common.search')}
            className="mb-2 h-7 text-xs"
          />
        )}
        <div
          className="max-h-[200px] overflow-y-auto overscroll-contain rounded-md border divide-y divide-border bg-popover"
          onWheel={(e) => { e.stopPropagation(); e.currentTarget.scrollTop += e.deltaY }}
        >
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => { onChange(c.id); setOpen(false); setSearch('') }}
              className={cn(
                'flex w-full items-center gap-2 px-2 py-1.5 text-xs transition-colors',
                c.id === value ? 'bg-accent/60 text-accent-foreground' : 'hover:bg-accent/30',
              )}
            >
              <span className="truncate">{c.name}</span>
              <span className="ml-auto text-[10px] text-muted-foreground/60">{c.type}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="py-2 text-center text-[10px] text-muted-foreground">{t('common.no_results')}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
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

/** Filter control that sources its own row data (front-only rows or server-fetched
 *  values). Separate component so the data hook runs per control (not in a .map). */
function FilterControlWithData({
  fc,
  value,
  onChange,
}: {
  fc: DashboardFilter
  value?: FilterValue
  onChange: (value: FilterValue) => void
}) {
  const rows = useFilterControlRows(fc)
  return <FilterControl fc={fc} rows={rows} value={value} onChange={onChange} />
}

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
          value={value as (FilterValue & { type: 'date' | 'date-relative' }) | undefined}
          presets={fc.datePresets ?? []}
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
            <div className="max-h-40 overflow-y-auto space-y-0.5">
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
}: {
  value?: { type: 'date'; from: string | null; to: string | null } | { type: 'date-relative'; count: number; unit: DatePresetUnit }
  presets: DatePreset[]
  onChange: (value: FilterValue) => void
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const isRelative = value?.type === 'date-relative'
  const from = value?.type === 'date' ? value.from : null
  const to = value?.type === 'date' ? value.to : null
  const hasValue = isRelative || !!(from || to)

  return (
    <div className="space-y-1.5">
      {presets.length > 0 && (
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
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <span className="text-[10px] font-medium text-muted-foreground">{t('dashboard.filter_date_from', 'From')}</span>
          <DatePickerField
            value={from ?? undefined}
            onChange={(v) => onChange({ type: 'date', from: v ?? null, to })}
          />
        </div>
        <div className="space-y-1">
          <span className="text-[10px] font-medium text-muted-foreground">{t('dashboard.filter_date_to', 'To')}</span>
          <DatePickerField
            value={to ?? undefined}
            onChange={(v) => onChange({ type: 'date', from, to: v ?? null })}
          />
        </div>
      </div>
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

// --- Date preset editor (edit mode) ---

function DatePresetEditor({
  presets,
  onChange,
}: {
  presets: DatePreset[]
  onChange: (presets: DatePreset[]) => void
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  // Local text state so the field can be emptied while typing (e.g. clear "1" before typing "2").
  const [countText, setCountText] = useState('1')
  const [unit, setUnit] = useState<DatePresetUnit>('week')
  const count = Math.max(1, Math.min(99, Number(countText) || 1))

  const add = () => {
    if (presets.some(p => p.count === count && p.unit === unit)) return
    onChange([...presets, { id: crypto.randomUUID(), count, unit }])
    setCountText(String(count))
  }
  const remove = (id: string) => onChange(presets.filter(p => p.id !== id))

  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] font-medium text-muted-foreground">{t('dashboard.filter_date_presets', 'Quick ranges')}</Label>
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
              {presetLabel(p.count, p.unit, lang)}
              <button type="button" onClick={() => remove(p.id)} className="hover:text-foreground">
                <X size={9} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-muted-foreground">{t('dashboard.filter_date_last', 'Last')}</span>
        <Input
          type="number"
          min={1}
          max={99}
          value={countText}
          onChange={(e) => setCountText(e.target.value)}
          onBlur={() => setCountText(String(count))}
          className="h-6 w-12 text-xs px-1.5"
        />
        <Select value={unit} onValueChange={(v) => setUnit(v as DatePresetUnit)}>
          <SelectTrigger className="h-6 text-[10px] flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" sideOffset={4}>
            <SelectItem value="day" className="text-xs">{t('dashboard.filter_date_unit_day', 'Day(s)')}</SelectItem>
            <SelectItem value="week" className="text-xs">{t('dashboard.filter_date_unit_week', 'Week(s)')}</SelectItem>
            <SelectItem value="month" className="text-xs">{t('dashboard.filter_date_unit_month', 'Month(s)')}</SelectItem>
            <SelectItem value="year" className="text-xs">{t('dashboard.filter_date_unit_year', 'Year(s)')}</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon-xs" onClick={add} title={t('common.add', 'Add')}>
          <Plus size={12} />
        </Button>
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
  tabs: DashboardTab[]
  widgets: DashboardWidget[]
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [search, setSearch] = useState('')

  // Reset the search box whenever the popover closes so it reopens clean.
  useEffect(() => {
    if (!popoverOpen) setSearch('')
  }, [popoverOpen])

  // Build widget options grouped by tab
  const widgetOptions = useMemo(() => {
    const result: { tabName: string; widgetId: string; widgetName: string }[] = []
    for (const tab of tabs) {
      const tabWidgets = widgets.filter(w => w.tabId === tab.id)
      for (const w of tabWidgets) {
        result.push({ tabName: localized(tab.name, lang), widgetId: w.id, widgetName: localized(w.name, lang) })
      }
    }
    return result
  }, [tabs, widgets, lang])

  const scopeType = scope.type

  const q = search.trim().toLowerCase()
  const filteredTabs = useMemo(
    () => (q ? tabs.filter(tab => localized(tab.name, lang).toLowerCase().includes(q)) : tabs),
    [tabs, q, lang],
  )
  const filteredWidgetOptions = useMemo(
    () => (q ? widgetOptions.filter(o => o.widgetName.toLowerCase().includes(q) || o.tabName.toLowerCase().includes(q)) : widgetOptions),
    [widgetOptions, q],
  )

  const scopeLabel = scopeType === 'all'
    ? t('dashboard.filter_scope_all')
    : scopeType === 'tabs'
      ? t('dashboard.filter_scope_tabs_count', { count: (scope as { tabIds: string[] }).tabIds.length })
      : t('dashboard.filter_scope_widgets_count', { count: (scope as { widgetIds: string[] }).widgetIds.length })

  return (
    <div className="space-y-1">
      <Label className="text-[10px] font-medium text-muted-foreground">{t('dashboard.filter_scope')}</Label>
      <Select
        value={scopeType}
        onValueChange={(v) => {
          if (v === 'all') onChange({ type: 'all' })
          else if (v === 'tabs') onChange({ type: 'tabs', tabIds: tabs.map(tab => tab.id) })
          else if (v === 'widgets') onChange({ type: 'widgets', widgetIds: widgets.map(w => w.id) })
        }}
      >
        <SelectTrigger className="h-7 text-xs w-full">
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
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t('common.search')}
              size="dense"
              className="mb-2"
            />
            <div className="mb-2 flex items-center gap-1">
              <button
                onClick={() => onChange({ type: 'tabs', tabIds: tabs.map(tab => tab.id) })}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                {t('common.select_all')}
              </button>
              <span className="text-[10px] text-muted-foreground">/</span>
              <button
                onClick={() => onChange({ type: 'tabs', tabIds: [] })}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                {t('common.select_none')}
              </button>
            </div>
            <TooltipProvider delayDuration={400}>
              <div className="max-h-40 overflow-y-auto space-y-0.5">
                {filteredTabs.map((tab) => {
                  const selected = (scope as { tabIds: string[] }).tabIds.includes(tab.id)
                  return (
                    <Tooltip key={tab.id}>
                      <TooltipTrigger asChild>
                        <label
                          className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent/50 rounded px-1.5 py-1"
                          style={tab.parentTabId ? { paddingLeft: 18 } : undefined}
                        >
                          <Checkbox
                            checked={selected}
                            onCheckedChange={() => {
                              const current = (scope as { tabIds: string[] }).tabIds
                              const next = selected ? current.filter(id => id !== tab.id) : [...current, tab.id]
                              onChange({ type: 'tabs', tabIds: next })
                            }}
                            className="size-3.5 shrink-0 [&_svg]:size-3"
                          />
                          <span className="truncate">{localized(tab.name, lang)}</span>
                        </label>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-64">{localized(tab.name, lang)}</TooltipContent>
                    </Tooltip>
                  )
                })}
                {filteredTabs.length === 0 && (
                  <p className="py-2 text-center text-[10px] text-muted-foreground">{t('common.no_results')}</p>
                )}
              </div>
            </TooltipProvider>
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
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t('common.search')}
              size="dense"
              className="mb-2"
            />
            <div className="mb-2 flex items-center gap-1">
              <button
                onClick={() => onChange({ type: 'widgets', widgetIds: widgets.map(w => w.id) })}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                {t('common.select_all')}
              </button>
              <span className="text-[10px] text-muted-foreground">/</span>
              <button
                onClick={() => onChange({ type: 'widgets', widgetIds: [] })}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                {t('common.select_none')}
              </button>
            </div>
            <TooltipProvider delayDuration={400}>
              <div className="max-h-48 overflow-y-auto space-y-0.5">
                {filteredWidgetOptions.map(({ tabName, widgetId, widgetName }) => {
                  const selected = (scope as { widgetIds: string[] }).widgetIds.includes(widgetId)
                  return (
                    <Tooltip key={widgetId}>
                      <TooltipTrigger asChild>
                        <label className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent/50 rounded px-1.5 py-1">
                          <Checkbox
                            checked={selected}
                            onCheckedChange={() => {
                              const current = (scope as { widgetIds: string[] }).widgetIds
                              const next = selected ? current.filter(id => id !== widgetId) : [...current, widgetId]
                              onChange({ type: 'widgets', widgetIds: next })
                            }}
                            className="size-3.5 shrink-0 [&_svg]:size-3"
                          />
                          <span className="truncate text-muted-foreground">{tabName}</span>
                          <span className="text-[10px] text-muted-foreground/60">›</span>
                          <span className="truncate">{widgetName}</span>
                        </label>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-64">{tabName} › {widgetName}</TooltipContent>
                    </Tooltip>
                  )
                })}
                {filteredWidgetOptions.length === 0 && (
                  <p className="text-[10px] text-muted-foreground italic text-center py-2">
                    {widgetOptions.length === 0 ? t('dashboard.filter_no_widgets') : t('common.no_results')}
                  </p>
                )}
              </div>
            </TooltipProvider>
          </PopoverContent>
        </Popover>
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
