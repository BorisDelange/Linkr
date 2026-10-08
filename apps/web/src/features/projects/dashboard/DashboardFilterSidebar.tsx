import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus, ChevronsUpDown, Settings2, Trash2 } from 'lucide-react'
import { SearchInput } from '@/components/ui/search-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import {
  RESIZE_HANDLE_ACTIVE, RESIZE_HANDLE_CLASS, useResizableSidebar,
} from '@/hooks/use-resizable-sidebar'
import { FilterConfigDialog, type FilterDraft } from './FilterConfigDialog'
import { FilterCard, FilterControlWithData, FilterPreview, IconAction } from './filter-controls'
import { isEmptyFilterValue } from './filter-value'
import type { Dashboard, DashboardFilter, DashboardFilterScope, DashboardTab, DashboardWidget, DatasetColumn, DatePreset, DatePresetUnit, FilterValue } from '@/types'
import { localized, setLocalized } from '@/lib/localized'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { presetLabel } from './date-presets'

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

  // Resizable width (drag the left edge). The default is wide enough that date
  // From/To fields aren't clipped.
  const { width, handleProps, resizing } = useResizableSidebar()

  // Which filter cards are expanded (collapsed by default to save space).
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpanded = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  // The `expanded` set flips each card from the collapsed default. So "collapse all" clears it
  // and "expand all" adds every filter id.
  const setAllExpanded = (open: boolean) => {
    setExpanded(open === DEFAULT_FILTER_OPEN ? new Set() : new Set(dashboard.filterConfig.map(fc => fc.id)))
  }

  // Add/edit go through one dialog; `configuring` holds the filter being edited
  // ('new' for the add flow, null when closed).
  const [configuring, setConfiguring] = useState<DashboardFilter | 'new' | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<DashboardFilter | null>(null)

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

  /** Apply a dialog draft: create the filter, or patch the one being edited. */
  const handleSubmitConfig = (draft: FilterDraft) => {
    if (!draft.datasetFileId || !draft.columnId) return
    // Bind the narrowed value: the guard above doesn't survive into the map callback below.
    const datasetFileId = draft.datasetFileId
    const cols = datasetFiles.find((f) => f.id === datasetFileId)?.columns ?? []
    const col = cols.find((c) => c.id === draft.columnId)
    if (!col) return
    const { type } = detectColumnDefaults(col)
    const trimmed = draft.label.trim()

    if (configuring === 'new') {
      const newFilter: DashboardFilter = {
        id: crypto.randomUUID(),
        datasetFileId,
        columnId: draft.columnId,
        columnName: col.name,
        type,
        inputType: draft.inputType,
        scope: draft.scope,
        ...(trimmed ? { label: setLocalized(undefined, language, trimmed) } : {}),
        ...(draft.datePresets.length ? { datePresets: draft.datePresets } : {}),
      }
      updateDashboard(dashboard.id, { filterConfig: [...dashboard.filterConfig, newFilter] })
    } else if (configuring) {
      const target = configuring
      // Dataset, column or input type changing invalidates any value already picked.
      const invalidated =
        target.datasetFileId !== draft.datasetFileId ||
        target.columnId !== draft.columnId ||
        target.inputType !== draft.inputType
      updateDashboard(dashboard.id, {
        filterConfig: dashboard.filterConfig.map((f) => {
          if (f.id !== target.id) return f
          // Edit only the active language, merged into the {en,fr} object (same convention
          // as tab/widget names). Drop the label entirely once no language holds a value.
          const nextLabel = setLocalized(f.label, language, trimmed)
          const hasAny = Object.values(nextLabel).some((v) => v.trim().length > 0)
          return {
            ...f,
            datasetFileId,
            columnId: col.id,
            columnName: col.name,
            type,
            inputType: draft.inputType,
            scope: draft.scope,
            label: hasAny ? nextLabel : undefined,
            datePresets: draft.datePresets,
          }
        }),
      })
      if (invalidated) clearFilter(target.id)
    }
    setConfiguring(null)
  }

  const handleConfirmRemoval = () => {
    if (!pendingRemoval) return
    updateDashboard(dashboard.id, {
      filterConfig: dashboard.filterConfig.filter((f) => f.id !== pendingRemoval.id),
    })
    clearFilter(pendingRemoval.id)
    setPendingRemoval(null)
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
    if (filterType === 'date') {
      options.push({ value: 'slider', label: t('dashboard.input_type_slider') })
      options.push({ value: 'slider-range', label: t('dashboard.input_type_slider_range') })
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
        {...handleProps}
        className={cn(RESIZE_HANDLE_CLASS, resizing && RESIZE_HANDLE_ACTIVE)}
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
            {dashboard.filterConfig.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t('dashboard.filter_no_columns')}
              </p>
            )}

            <TooltipProvider delayDuration={300}>
              {dashboard.filterConfig.map((fc) => {
                // Filters are collapsed by default to save space; the `expanded` set flips that.
                const isOpen = expanded.has(fc.id) ? !DEFAULT_FILTER_OPEN : DEFAULT_FILTER_OPEN
                return (
                  <FilterCard
                    key={fc.id}
                    fc={fc}
                    open={isOpen}
                    onToggle={() => toggleExpanded(fc.id)}
                    active={!!activeFilters[fc.id]}
                    tabs={tabs}
                    widgets={widgets}
                    actions={editMode && (
                      <>
                        <IconAction label={t('dashboard.filter_configure')} onClick={() => setConfiguring(fc)}>
                          <Settings2 size={12} />
                        </IconAction>
                        <IconAction label={t('common.delete')} onClick={() => setPendingRemoval(fc)} className="-mr-1">
                          <Trash2 size={12} />
                        </IconAction>
                      </>
                    )}
                  >
                    <FilterControlWithData
                      fc={fc}
                      value={activeFilters[fc.id]}
                      onChange={(v) => handleFilterChange(fc.id, v)}
                    />
                  </FilterCard>
                )
              })}
            </TooltipProvider>

            {/* Add filter — edit mode only; the fields live in the config dialog */}
            {editMode && (
              <Button
                size="sm"
                className="w-full gap-1.5 text-xs"
                onClick={() => setConfiguring('new')}
              >
                <Plus size={12} />
                {t('dashboard.filter_add')}
              </Button>
            )}
          </div>
        </ScrollArea>

      <FilterConfigDialog
        open={configuring !== null}
        onOpenChange={(o) => { if (!o) setConfiguring(null) }}
        filter={configuring && configuring !== 'new' ? configuring : undefined}
        datasetFiles={datasetFiles}
        availableDatasets={availableDatasets}
        language={language}
        onSubmit={handleSubmitConfig}
        getInputTypeOptions={getInputTypeOptions}
        detectColumnDefaults={detectColumnDefaults}
        renderColumnPicker={(columns, value, onChange) => (
          <ColumnPicker
            columns={columns}
            value={value}
            onChange={onChange}
            placeholder={t('dashboard.filter_select_column')}
          />
        )}
        renderScope={(scope, onChange) => (
          <FilterScopeSelector scope={scope} onChange={onChange} tabs={tabs} widgets={widgets} />
        )}
        renderDatePresets={(presets, onChange) => (
          <DatePresetEditor presets={presets} onChange={onChange} />
        )}
        renderPreview={(filter) => (
          <FilterPreview
            key={`${filter.datasetFileId}|${filter.columnId}|${filter.inputType}`}
            fc={filter}
            tabs={tabs}
            widgets={widgets}
          />
        )}
      />

      <AlertDialog open={pendingRemoval !== null} onOpenChange={(o) => { if (!o) setPendingRemoval(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dashboard.filter_delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('dashboard.filter_delete_description', {
                name: pendingRemoval
                  ? localized(pendingRemoval.label, language) || pendingRemoval.columnName
                  : '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmRemoval}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
        {/* h-8 to match the SelectTriggers it sits between in the filter dialog. */}
        <button className="flex h-8 w-full items-center justify-between rounded-md border px-3 text-xs hover:bg-accent/50 transition-colors">
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
          <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2" align="start">
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
              {/* onWheel: Radix blocks wheel events on popover content to stop scroll
                  leaking to the page, which also kills scrolling inside this list. */}
              <div
                className="max-h-40 space-y-0.5 overflow-y-auto overscroll-contain"
                onWheel={(e) => { e.stopPropagation(); e.currentTarget.scrollTop += e.deltaY }}
              >
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
          <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2" align="start">
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
              <div
                className="max-h-48 space-y-0.5 overflow-y-auto overscroll-contain"
                onWheel={(e) => { e.stopPropagation(); e.currentTarget.scrollTop += e.deltaY }}
              >
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
