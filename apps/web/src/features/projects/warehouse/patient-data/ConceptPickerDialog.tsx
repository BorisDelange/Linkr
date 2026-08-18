import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Check, ListPlus, Search, SlidersHorizontal, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { columnLabel } from '@/lib/format-helpers'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import { defaultConceptColorName } from '@/lib/concept-colors'
import { COLOR_PALETTE } from '@/components/ui/color-picker-popover'
import { useConceptListStore } from '@/stores/concept-list-store'
import { mergeSelection, appendListConcepts } from './concept-selection'
import { usePatientChartContext } from './PatientChartContext'
import { ConceptStatsPopover } from './ConceptStatsPopover'
import { useConcepts, type ConceptRow } from '../concepts/use-concepts'
import { ConceptTable } from '../concepts/ConceptTable'
import { DEFAULT_HIDDEN_COLUMNS } from '../concepts/concept-queries'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import type { PluginConfigField } from '@/types/plugin'
import type { VisibilityState } from '@tanstack/react-table'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Generic config dialog for warehouse widgets that combine a concept selection
 * with a schema-driven settings form. The Settings tab reuses the shared
 * GenericConfigPanel (same UI as dashboard plugins). The `conceptIds` key is
 * managed by the Concepts tab; all other keys are driven by `schema`.
 */
interface ConceptPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Full widget config (conceptIds + schema-driven settings). */
  config: Record<string, unknown>
  /** Plugin configSchema for the settings form (excluding conceptIds). */
  schema?: Record<string, PluginConfigField>
  /** Which tab to open on mount. Defaults to settings when a schema exists. */
  initialTab?: 'settings' | 'concepts'
  onConfirm: (config: Record<string, unknown>) => void
}

/** Heavy OMOP detail the picker keeps one click away, on top of the page's own. */
const PICKER_HIDDEN_COLUMNS = [...DEFAULT_HIDDEN_COLUMNS, 'domain_id', 'concept_class_id', '_dict_key']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compact swatch-only color picker for a selected concept, reusing the shared
 * COLOR_PALETTE so colors match the dashboard plugins. `value` is a palette
 * name or hex; `null`/undefined means "auto" (rotating default palette).
 */
function ConceptColorSwatch({
  value,
  index,
  onChange,
}: {
  value: string | undefined
  /** Position in the selection: drives the auto colour when none is set. */
  index: number
  onChange: (color: string | undefined) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // With no explicit choice the swatch shows the colour the chart will actually
  // use, not an empty grey circle that reads as "no colour".
  const effective = value ?? defaultConceptColorName(index)
  const entry = COLOR_PALETTE.find((c) => c.name === effective)
  const isHex = effective.startsWith('#')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="size-4 shrink-0 rounded-full border border-border"
          style={isHex ? { backgroundColor: effective } : undefined}
          title={t('patient_data.concept_color')}
          onClick={(e) => e.stopPropagation()}
        >
          {!isHex && (
            <span
              className={cn(
                'block size-full rounded-full',
                entry ? entry.bg : 'bg-foreground/15',
              )}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-2"
        align="end"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grid grid-cols-5 gap-1">
          <button
            type="button"
            className="flex size-5 items-center justify-center rounded-full border border-dashed border-border text-[8px] text-muted-foreground"
            title={t('common.auto')}
            onClick={() => { onChange(undefined); setOpen(false) }}
          >
            A
          </button>
          {COLOR_PALETTE.filter((c) => c.name !== 'none').map((c) => (
            <button
              key={c.name}
              type="button"
              className={cn('size-5 rounded-full', c.bg, value === c.name && 'ring-2 ring-offset-1 ring-offset-popover', value === c.name && c.ring)}
              title={c.name}
              onClick={() => { onChange(c.name); setOpen(false) }}
            />
          ))}
        </div>
        {/* Custom hex picker */}
        <label className="mt-2 flex items-center gap-1.5 border-t pt-2 text-[10px] text-muted-foreground">
          <span
            className="size-4 shrink-0 rounded-full border border-border"
            style={{ backgroundColor: isHex ? value : 'transparent' }}
          />
          <span className="flex-1">{t('patient_data.custom_color')}</span>
          <input
            type="color"
            value={isHex ? (value as string) : '#3b82f6'}
            onChange={(e) => onChange(e.target.value)}
            className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
          />
        </label>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ConceptPickerDialog({
  open,
  onOpenChange,
  config,
  schema,
  initialTab,
  onConfirm,
}: ConceptPickerDialogProps) {
  const { t, i18n } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()

  const [activeTab, setActiveTab] = useState<'settings' | 'concepts'>('settings')

  // Selection ORDER is the contract: the chart colours concepts by position, so
  // this is an array, not a Set. The Set below is derived, for O(1) lookups.
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])

  // Selected concept names cache (to display names in the right panel)
  const [selectedNames, setSelectedNames] = useState<Map<number, string>>(new Map())

  // Local schema-driven settings (everything except conceptIds)
  const [settings, setSettings] = useState<Record<string, unknown>>({})

  // Reuse the concepts hook for full-featured data table
  const hook = useConcepts(open ? dataSourceId : undefined, open ? schemaMapping : undefined)

  // Dict key for the stats popover (multi-dict picks the row's own).
  const dicts = schemaMapping?.conceptTables ?? []

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => Object.fromEntries(PICKER_HIDDEN_COLUMNS.map((id) => [id, false])),
  )

  // Toolbar search: typed locally, committed on Enter / the Search button so a
  // fuzzy scan over the whole dictionary doesn't fire on every keystroke.
  const [pendingSearch, setPendingSearch] = useState('')
  const commitSearch = () => hook.updateFilter('_searchFuzzy', pendingSearch.trim() || null)
  const clearSearch = () => {
    setPendingSearch('')
    if (hook.filters._searchFuzzy) hook.updateFilter('_searchFuzzy', null)
  }

  // Saved, project-scoped concept lists — a picked list seeds the selection.
  const {
    conceptLists,
    loaded: listsLoaded,
    loadConceptLists,
  } = useConceptListStore()

  useEffect(() => {
    if (open && !listsLoaded) loadConceptLists()
  }, [open, listsLoaded, loadConceptLists])

  const projectLists = useMemo(
    () => conceptLists.filter((l) => l.projectUid === projectUid),
    [conceptLists, projectUid],
  )

  // Sync from props when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedIds([...((config.conceptIds as number[]) ?? [])])
      const { conceptIds: _omit, ...rest } = config
      setSettings(rest)
      const hasSchema = !!schema && Object.keys(schema).length > 0
      setActiveTab(initialTab && (initialTab === 'concepts' || hasSchema) ? initialTab : hasSchema ? 'settings' : 'concepts')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Keep selectedNames updated from concepts data
  useEffect(() => {
    if (!hook.concepts.length) return
    setSelectedNames((prev) => {
      const next = new Map(prev)
      for (const c of hook.concepts) {
        if (!next.has(c.concept_id)) {
          next.set(c.concept_id, c.concept_name)
        }
      }
      return next
    })
  }, [hook.concepts])

  /** Remember a row's name so the selected panel can label it off-page. */
  const rememberName = useCallback((row: ConceptRow) => {
    setSelectedNames((prev) => {
      if (prev.get(row.concept_id) === row.concept_name) return prev
      const next = new Map(prev)
      next.set(row.concept_id, row.concept_name)
      return next
    })
  }, [])

  /** Selection changes arrive as a Set from the table; fold it back onto the
   *  ordered array so existing positions (and therefore colours) never move. */
  const applySelection = useCallback((next: Set<number>) => {
    setSelectedIds((prev) => mergeSelection(prev, next))
  }, [])

  const removeConcept = useCallback((conceptId: number) => {
    setSelectedIds((prev) => prev.filter((id) => id !== conceptId))
  }, [])

  const clearAll = useCallback(() => {
    setSelectedIds([])
  }, [])

  /** Import a saved list: additive, appended in list order after what is already
   *  picked, so the existing selection keeps its colours. */
  const importList = useCallback((listId: string) => {
    const list = projectLists.find((l) => l.id === listId)
    if (!list) return
    setSelectedNames((prev) => {
      const next = new Map(prev)
      for (const item of list.items) {
        if (item.conceptName) next.set(item.conceptId, item.conceptName)
      }
      return next
    })
    setSelectedIds((prev) => appendListConcepts(prev, list.items.map((i) => i.conceptId)))
  }, [projectLists])

  const handleConfirm = () => {
    onConfirm({ ...settings, conceptIds: [...selectedIds] })
  }

  const handleConfigChange = useCallback((changes: Record<string, unknown>) => {
    setSettings((prev) => ({ ...prev, ...changes }))
  }, [])

  // Per-concept colors live in the config alongside the other settings.
  const conceptColors = (settings.conceptColors as Record<string, string> | undefined) ?? {}
  const setConceptColor = useCallback(
    (conceptId: number, color: string | undefined) => {
      setSettings((prev) => {
        const next = { ...((prev.conceptColors as Record<string, string>) ?? {}) }
        if (color) next[String(conceptId)] = color
        else delete next[String(conceptId)]
        return { ...prev, conceptColors: next }
      })
    },
    [],
  )

  // Filters popover — same control set as the Concepts page toolbar.
  const filterableColumns = useMemo(
    () => hook.availableColumns.filter((c) => c.filterable && (hook.filterOptions[c.id]?.length ?? 0) > 0),
    [hook.availableColumns, hook.filterOptions],
  )
  const selectedFilterValues = (columnId: string) => {
    const raw = hook.filters[columnId]
    return Array.isArray(raw) ? raw : raw ? [raw] : []
  }
  const standardOptionLabel = (value: string) =>
    value === 'S' ? t('concepts.standard_s')
      : value === 'C' ? t('concepts.standard_c')
        : t('concepts.standard_non')
  const activeFilterCount = filterableColumns.reduce(
    (n, col) => n + (selectedFilterValues(col.id).length > 0 ? 1 : 0),
    0,
  )

  // Stable identity: ConceptTable rebuilds its columns whenever `rowAction`
  // changes, so a fresh object per render would churn every column definition.
  const defaultDictKey = dicts[0]?.key ?? ''
  const rowAction = useMemo(
    () => ({
      render: (row: ConceptRow) => (
        <ConceptStatsPopover
          dataSourceId={dataSourceId}
          schemaMapping={schemaMapping}
          conceptId={row.concept_id}
          dictKey={(row._dict_key as string) ?? defaultDictKey}
        />
      ),
    }),
    [dataSourceId, schemaMapping, defaultDictKey],
  )

  // Selected concepts in pick order — the index drives the auto colour.
  const selectedList = useMemo(
    () => selectedIds.map((id) => ({ id, name: selectedNames.get(id) ?? `#${id}` })),
    [selectedIds, selectedNames],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex h-[85vh] max-h-[85vh] flex-col gap-0 p-0 transition-[max-width] duration-300 ease-in-out',
          // Settings is a compact form — shrink the modal so the panel can
          // span the full (narrower) width centered; Concepts needs the room.
          activeTab === 'settings'
            ? 'max-w-2xl sm:max-w-2xl'
            : 'max-w-[95vw] sm:max-w-[95vw]',
        )}
      >
        <DialogHeader className="shrink-0 border-b px-6 py-3">
          <DialogTitle>{t('patient_data.configure_widget')}</DialogTitle>
        </DialogHeader>

        {/* Tab switcher — Settings only shown when the widget exposes a schema */}
        <div className="flex shrink-0 items-center gap-1 border-b px-4 py-2">
          {schema && Object.keys(schema).length > 0 && (
            <Button
              variant={activeTab === 'settings' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setActiveTab('settings')}
            >
              {t('patient_data.tab_settings')}
            </Button>
          )}
          <Button
            variant={activeTab === 'concepts' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setActiveTab('concepts')}
          >
            {t('patient_data.tab_concepts')}
            <Badge variant="outline" className="ml-1.5 text-[10px]">
              {selectedIds.length}
            </Badge>
          </Button>
        </div>

        {activeTab === 'concepts' ? (
          /* Concepts tab: table + selected panel (resizable divider) */
          <div className="flex min-h-0 flex-1">
            <Allotment proportionalLayout={false}>
            <Allotment.Pane minSize={360}>
            {/* Left: concept table */}
            <div className="flex h-full min-w-0 flex-col overflow-hidden border-r">
              {/* Toolbar — same controls, order and sizing as the Concepts page. */}
              <TooltipProvider delayDuration={300}>
                <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
                  <Popover>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className={`h-8 w-8 shrink-0 ${activeFilterCount > 0 ? 'text-primary' : ''}`}
                          >
                            <SlidersHorizontal size={14} />
                          </Button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">{t('common.filters')}</TooltipContent>
                    </Tooltip>
                    <PopoverContent
                      align="start"
                      className="w-[280px] space-y-3 p-3"
                      onCloseAutoFocus={(e) => e.preventDefault()}
                    >
                      {filterableColumns.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t('concepts.no_filters')}</p>
                      ) : (
                        filterableColumns.map((col) => (
                          <div key={col.id} className="space-y-1">
                            <p className="text-xs font-medium text-muted-foreground">
                              {columnLabel(col.id)}
                            </p>
                            <MultiSelectFilter
                              value={selectedFilterValues(col.id)}
                              options={(hook.filterOptions[col.id] ?? []).map((v) =>
                                col.id === 'standard_concept'
                                  ? { value: v, label: standardOptionLabel(v) }
                                  : v,
                              )}
                              placeholder={columnLabel(col.id)}
                              onChange={(next) => hook.updateFilter(col.id, next.length ? next : null)}
                              triggerClass="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus:border-primary"
                              popoverWidthClass="w-[300px]"
                            />
                          </div>
                        ))
                      )}
                    </PopoverContent>
                  </Popover>

                  {/* Fuzzy search — commits on Enter or the Search button, like
                      the Concepts page (a keystroke-debounced query over 1.5M
                      rows would fire a full fuzzy scan per character). */}
                  <div className="relative min-w-0 flex-1">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-8 pl-8 pr-7 text-xs"
                      value={pendingSearch}
                      onChange={(e) => setPendingSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitSearch() }
                        else if (e.key === 'Escape') { e.preventDefault(); clearSearch() }
                      }}
                      placeholder={t('concepts.search_concepts')}
                    />
                    {pendingSearch && (
                      <button
                        type="button"
                        onClick={clearSearch}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={t('common.clear')}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  <Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" onClick={commitSearch}>
                    {t('common.search')}
                  </Button>

                  {/* Import a saved concept list into the current selection. */}
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant="outline"
                            className="h-8 w-8 shrink-0"
                            aria-label={t('patient_data.import_from_list')}
                          >
                            <ListPlus size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">
                        {t('patient_data.import_from_list')}
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end" className="w-[240px]">
                      <DropdownMenuLabel className="text-xs">
                        {t('patient_data.import_from_list')}
                      </DropdownMenuLabel>
                      {projectLists.length === 0 ? (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">
                          {t('concepts.list_none')}
                        </p>
                      ) : (
                        projectLists.map((l) => (
                          <DropdownMenuItem
                            key={l.id}
                            className="text-xs"
                            onClick={() => importList(l.id)}
                          >
                            <span className="truncate">
                              {localized(l.name, i18n.language) || t('concepts.list_untitled')}
                            </span>
                            <span className="ml-auto text-[10px] text-muted-foreground">
                              {l.items.length}
                            </span>
                          </DropdownMenuItem>
                        ))
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TooltipProvider>

              {/* The Concepts page's own table: sort, resize, reorder,
                  multi-select filters and the Columns menu, in pick mode. */}
              <div className="min-h-0 flex-1">
                <ConceptTable
                  concepts={hook.concepts}
                  totalCount={hook.totalCount}
                  page={hook.page}
                  pageSize={hook.pageSize}
                  totalPages={hook.totalPages}
                  isLoading={hook.isLoading}
                  selectedConceptId={null}
                  availableColumns={hook.availableColumns}
                  filters={hook.filters}
                  filterOptions={hook.filterOptions}
                  sorting={hook.sorting}
                  columnVisibility={columnVisibility}
                  onColumnVisibilityChange={setColumnVisibility}
                  onFilterChange={hook.updateFilter}
                  onSortingChange={hook.updateSorting}
                  onSelect={() => {}}
                  selectedConceptIds={selectedIdSet}
                  onSelectedConceptIdsChange={applySelection}
                  onPageChange={hook.setPage}
                  onPageSizeChange={(size) => {
                    hook.setPageSize(size)
                    hook.setPage(0)
                  }}
                  pickMode
                  onToggleConcept={rememberName}
                  rowAction={rowAction}
                  emptyMessage={t('patient_data.no_concepts_found')}
                />
              </div>
            </div>
            </Allotment.Pane>

            {/* Right: selected concepts panel — fixed, capped width so it
                always opens compact (never a proportion of the wide modal). */}
            <Allotment.Pane minSize={200} preferredSize={300} maxSize={420}>
            <div className="flex h-full min-w-0 flex-col">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="text-xs font-medium">
                  {t('patient_data.selected_concepts')}
                </span>
                <Badge variant="secondary" className="text-[10px]">
                  {selectedIds.length}
                </Badge>
              </div>
              {selectedList.length === 0 ? (
                <div className="flex flex-1 items-center justify-center p-4">
                  <p className="text-center text-xs text-muted-foreground">
                    {t('patient_data.no_concepts_selected')}
                  </p>
                </div>
              ) : (
                <>
                  <ScrollArea className="min-h-0 flex-1 [&>div>div]:!block [&>div>div]:!min-w-0">
                    <div className="p-1.5">
                      {selectedList.map((item, index) => (
                        <div
                          key={item.id}
                          className="group flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-accent/50"
                        >
                          <button
                            type="button"
                            className="flex size-4 shrink-0 items-center justify-center rounded border border-primary bg-primary text-primary-foreground"
                            onClick={() => removeConcept(item.id)}
                            title={t('patient_data.remove')}
                          >
                            <Check size={10} />
                          </button>
                          <ConceptColorSwatch
                            value={conceptColors[String(item.id)]}
                            index={index}
                            onChange={(color) => setConceptColor(item.id, color)}
                          />
                          <span className="min-w-0 flex-1 truncate text-xs">
                            {item.name}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                            {item.id}
                          </span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                  <div className="border-t px-3 py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-full text-xs text-muted-foreground"
                      onClick={clearAll}
                    >
                      {t('patient_data.clear_selection')}
                    </Button>
                  </div>
                </>
              )}
            </div>
            </Allotment.Pane>
            </Allotment>
          </div>
        ) : (
          /* Settings tab — schema-driven, shared with dashboard plugins */
          <ScrollArea className="min-h-0 flex-1">
            {/* Compact modal: full width, tighter rows than dashboards, and
                shorter boolean rows so checkboxes sit closer together. */}
            <div className="[&_.space-y-3]:space-y-1.5 [&_.h-8]:h-7">
              {schema && Object.keys(schema).length > 0 ? (
                <GenericConfigPanel
                  schema={schema}
                  config={settings}
                  columns={[]}
                  onConfigChange={handleConfigChange}
                />
              ) : (
                <p className="px-6 py-8 text-center text-sm text-muted-foreground">
                  {t('patient_data.no_settings')}
                </p>
              )}
            </div>
          </ScrollArea>
        )}

        <DialogFooter className="shrink-0 border-t px-6 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleConfirm}>
            {t('common.confirm')} ({selectedIds.length})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
