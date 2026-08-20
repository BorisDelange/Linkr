import { useState, useMemo, useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Settings2,
  BarChart3,
  Loader2,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Check,
  SlidersHorizontal,
  Plus,
  List,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { TruncatedText } from '@/components/ui/truncated-text'
import { TruncatedHeader, headerLabel } from '@/components/ui/truncated-header'
// Select imports removed — ColumnFilterSelect now uses DropdownMenu
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ColumnVisibilityMenu } from '@/components/ui/column-visibility-menu'
import type { SourceConceptFilters, SourceConceptSorting } from '@/lib/concept-mapping/mapping-queries'
import { SUGGESTION_CATEGORIES, type SuggestionCategory } from '@/types'
import type { SourceConceptRow } from '../MappingEditorTab'
import type { ConceptDictionary } from '@/types/schema-mapping'
import type { ConceptMapping } from '@/types'
import type { ExternalMappingInfo } from '@/stores/concept-mapping-store'

export type MappingStatusFilter = 'all' | 'unmapped' | 'mapped' | 'mapped_elsewhere'

// Columns kept out of the value tooltip: the cell is interactive or graphical
// with nothing to copy (_status, _info), or its renderer formats the raw value
// with thousands separators that the tooltip's String(raw) would undo.
// concept_id is NOT here — it is among the most worth copying, and its accessor
// returns null when no id is assigned, which the null guard already sends down
// the normal renderer (the em dash).
const NO_TOOLTIP_COLUMNS = new Set(['_status', '_info', 'patient_count', 'record_count'])
// Columns rendered in a monospace font (kept in the tooltip cell).
const MONO_COLUMNS = new Set(['concept_code', 'concept_id'])

interface SourceConceptTableProps {
  rows: SourceConceptRow[]
  totalCount: number
  loading: boolean
  queryError?: string | null
  filters: SourceConceptFilters
  sorting: SourceConceptSorting | null
  filterOptions: Record<string, string[]>
  conceptDicts: ConceptDictionary[]
  mappingStatusMap: Map<number, string>
  /** Set of source concept IDs that are mapped in another project. */
  mappedElsewhereIds: Set<number>
  /** Local mappings of the current project (used to show tooltip detail for "mapped" rows). */
  projectMappings?: ConceptMapping[]
  /** Cross-project mappings, keyed by `vocabulary:code`. */
  externalMappingsByKey?: Map<string, ExternalMappingInfo[]>
  /** Resolved source concept IDs from the workspace badge registry, keyed by `${vocabulary}__${code}`. */
  sourceConceptIdMap?: Map<string, number>
  /** True when the project is file-based AND does NOT have a `conceptIdColumn` mapped.
   *  In that case, the displayed source_concept_id is the registry-assigned one (or '—'),
   *  not the artificial row-number `concept_id`. */
  isFileSourceWithoutConceptId?: boolean
  mappingStatusFilter: MappingStatusFilter
  selectedConceptId: number | null
  /** Multi-selection set (Ctrl/Cmd/Shift click) — feeds the "add to copy list" button. */
  selectedConceptIds: Set<number>
  onSelectedConceptIdsChange: (ids: Set<number>) => void
  /** Add the current multi-selection to the copy list. */
  onAddSelectionToList: () => void
  /** Open the copy-list modal. */
  onOpenList: () => void
  /** Number of concepts currently in the copy list (shown as a badge). */
  listCount: number
  /** True when source is a file import. */
  isFileSource?: boolean
  /** True when file source has record count column mapped. */
  hasRecordCount?: boolean
  /** True when file source has patient count column mapped. */
  hasPatientCount?: boolean
  /** True when at least one row has info_json data. */
  hasInfoJson?: boolean
  /** Zero-based current page, and the total the SQL COUNT(*) reported. */
  page: number
  totalPages: number
  onPageChange: (page: number) => void
  onFiltersChange: (filters: SourceConceptFilters) => void
  onSortingChange: (sorting: SourceConceptSorting | null) => void
  onMappingStatusFilterChange: (filter: MappingStatusFilter) => void
  onSelectConcept: (id: number | null) => void
  /** Set of source concept IDs marked as ignored. */
  ignoredConceptIds: Set<number>
  /** Show concept detail view (chart icon click). */
  onShowDetail?: (row: SourceConceptRow) => void
  /** Scroll position to restore when the table remounts after detail view. */
  initialScrollTop?: number
  /** Called on every scroll so the parent can persist the position. */
  onScrollTopChange?: (scrollTop: number) => void
  /** Import a single external mapping into the active project. The local
   *  source concept id is required so the imported row is wired to the current
   *  project's concept dictionary (and the dot turns green immediately). */
  onImportExternal?: (info: ExternalMappingInfo, localSourceConceptId: number) => Promise<void> | void
  /** Suggestion-category filter (Syntactic / Semantic / … / Data dictionary). */
  suggestionCategories: Set<SuggestionCategory>
  onSuggestionCategoriesChange: (next: Set<SuggestionCategory>) => void
  /** True when a scores file is loaded; the category filter is disabled otherwise. */
  hasScores: boolean
}

const FILTER_INPUT_CLASS = 'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

/** Text input that debounces onChange by 300ms. */
function DebouncedInput({
  value: externalValue,
  onChange,
  className,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  className?: string
  placeholder?: string
}) {
  const [localValue, setLocalValue] = useState(externalValue)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Sync from external when it changes (e.g. filters reset)
  useEffect(() => {
    setLocalValue(externalValue)
  }, [externalValue])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setLocalValue(v)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => onChange(v), 300)
  }

  useEffect(() => () => clearTimeout(timerRef.current), [])

  return (
    <input
      className={className}
      placeholder={placeholder}
      value={localValue}
      onChange={handleChange}
    />
  )
}

const STATUS_COLORS: Record<string, string> = {
  unmapped: 'bg-gray-300',
  mapped: 'bg-green-500',
  mapped_elsewhere: 'bg-blue-500',
  ignored: 'bg-gray-400',
}

/** Get human-readable label for a TanStack column def. */
function getColLabel(colDefs: ColumnDef<SourceConceptRow>[], id: string): string {
  const def = colDefs.find((c) => 'id' in c && c.id === id)
  if (def) {
    if (typeof def.header === 'function') {
      const result = (def.header as () => unknown)()
      if (typeof result === 'string') return result
    }
    if (typeof def.header === 'string') return def.header
  }
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function SortIndicator({ columnId, sorting }: { columnId: string; sorting: SourceConceptSorting | null }) {
  if (!sorting || sorting.columnId !== columnId) {
    return <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
  }
  if (sorting.desc) {
    return <ArrowDown size={10} className="shrink-0 text-primary" />
  }
  return <ArrowUp size={10} className="shrink-0 text-primary" />
}

export function SourceConceptTable({
  rows,
  totalCount,
  loading,
  queryError,
  filters,
  sorting,
  filterOptions,
  conceptDicts,
  mappingStatusMap,
  mappedElsewhereIds,
  projectMappings,
  externalMappingsByKey,
  sourceConceptIdMap,
  isFileSourceWithoutConceptId,
  mappingStatusFilter,
  selectedConceptId,
  selectedConceptIds,
  onSelectedConceptIdsChange,
  onAddSelectionToList,
  onOpenList,
  listCount,
  isFileSource,
  hasRecordCount,
  hasPatientCount,
  hasInfoJson,
  page,
  totalPages,
  onPageChange,
  onFiltersChange,
  onSortingChange,
  onMappingStatusFilterChange,
  ignoredConceptIds,
  onSelectConcept,
  onShowDetail,
  initialScrollTop,
  onScrollTopChange,
  onImportExternal,
  suggestionCategories,
  onSuggestionCategoriesChange,
  hasScores,
}: SourceConceptTableProps) {
  const { t } = useTranslation()
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})
  // When the user clicks "View list" on a blue dot, this holds the list of
  // external mappings to display in a dedicated modal (always opens via the modal,
  // even when there are <5 — keeps interaction consistent regardless of list size).
  const [externalListModal, setExternalListModal] = useState<{
    list: ExternalMappingInfo[]
    sourceLabel: string
    localSourceConceptId: number
  } | null>(null)
  // Per-info importing state so the inline import buttons show a spinner.
  const [importingInfoIds, setImportingInfoIds] = useState<Set<string>>(new Set())
  // After a successful import the modal swaps to a "✓ Alignement importé"
  // confirmation panel for ~1s before closing.
  const [justImportedIds, setJustImportedIds] = useState<Set<string>>(new Set())
  // Transient confirmation shown after a popover-initiated import (the popover
  // itself is left to close on its own).
  const [importConfirmationOpen, setImportConfirmationOpen] = useState(false)
  const handleImportInfo = async (
    info: ExternalMappingInfo,
    localSourceConceptId: number,
    opts?: { closeModal?: boolean; showConfirmation?: boolean },
  ) => {
    if (!onImportExternal) return
    const k = `${info.sourceProjectId}::${info.mapping.id}`
    setImportingInfoIds((prev) => { const s = new Set(prev); s.add(k); return s })
    try {
      await onImportExternal(info, localSourceConceptId)
      setJustImportedIds((prev) => { const s = new Set(prev); s.add(k); return s })
      if (opts?.showConfirmation) setImportConfirmationOpen(true)
      window.setTimeout(() => {
        setJustImportedIds((prev) => { const s = new Set(prev); s.delete(k); return s })
        if (opts?.closeModal) setExternalListModal(null)
        if (opts?.showConfirmation) setImportConfirmationOpen(false)
      }, 1000)
    } finally {
      setImportingInfoIds((prev) => { const s = new Set(prev); s.delete(k); return s })
    }
  }

  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  const onScrollTopChangeRef = useRef(onScrollTopChange)
  onScrollTopChangeRef.current = onScrollTopChange

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    // Restore scroll position when remounting after detail view
    if (initialScrollTop) {
      el.scrollTop = initialScrollTop
    }
    const onScroll = () => onScrollTopChangeRef.current?.(el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // A page swap replaces every row: staying scrolled down would read as nothing
  // having happened.
  useEffect(() => { scrollContainerRef.current?.scrollTo({ top: 0 }) }, [page])

  const handleSort = (columnId: string) => {
    if (columnId === '_info') return
    if (sorting?.columnId === columnId) {
      if (sorting.desc) onSortingChange({ columnId, desc: false })
      else onSortingChange(null)
    } else {
      onSortingChange({ columnId, desc: true })
    }
  }

  // Anchor for shift-range selection — the last row clicked without Shift.
  const selectionAnchorRef = useRef<number | null>(null)

  /** File-explorer-style selection: plain / Ctrl-Cmd (toggle) / Shift (range). */
  const handleRowClick = (conceptId: number, e: React.MouseEvent) => {
    const isToggle = e.metaKey || e.ctrlKey
    const isRange = e.shiftKey

    if (isRange && selectionAnchorRef.current != null) {
      const order = rows.map((r) => r.concept_id)
      const from = order.indexOf(selectionAnchorRef.current)
      const to = order.indexOf(conceptId)
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        const range = order.slice(lo, hi + 1)
        const next = isToggle ? new Set(selectedConceptIds) : new Set<number>()
        for (const id of range) next.add(id)
        onSelectedConceptIdsChange(next)
        return
      }
    }

    if (isToggle) {
      const next = new Set(selectedConceptIds)
      if (next.has(conceptId)) next.delete(conceptId)
      else next.add(conceptId)
      selectionAnchorRef.current = conceptId
      onSelectedConceptIdsChange(next)
      return
    }

    // Plain click → single selection (drives the right mapping panel).
    selectionAnchorRef.current = conceptId
    onSelectedConceptIdsChange(new Set([conceptId]))
    onSelectConcept(conceptId)
  }

  const MAPPING_STATUS_OPTIONS: MappingStatusFilter[] = ['all', 'unmapped', 'mapped', 'mapped_elsewhere']

  // Determine which optional columns are available based on the schema dicts
  const hasCategory = conceptDicts.some((d) => !!d.categoryColumn) || (isFileSource && (filterOptions.category?.length ?? 0) > 0)
  const hasSubcategory = conceptDicts.some((d) => !!d.subcategoryColumn) || (isFileSource && (filterOptions.subcategory?.length ?? 0) > 0)
  const hasExtraColumns = conceptDicts.some((d) => d.extraColumns && Object.keys(d.extraColumns).length > 0)
  // For file sources, check if terminology/domain/class columns exist in data
  const fileHasTerminology = isFileSource && filterOptions.terminology_name?.length > 0
  const fileHasDomain = isFileSource && filterOptions.domain_id?.length > 0
  const fileHasClass = isFileSource && filterOptions.concept_class_id?.length > 0

  // Initial column visibility: hide extra OMOP columns by default
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
    const hidden: VisibilityState = {
      // Source concept ID is hidden by default — toggleable via the Columns menu.
      concept_id: false,
    }
    if (hasExtraColumns) {
      // domain_id and concept_class_id are hidden by default (available via toggle)
      hidden['domain_id'] = false
      hidden['concept_class_id'] = false
    }
    return hidden
  })

  /** Render inline column filter for a given column. */
  const renderColumnFilter = (columnId: string) => {
    if (columnId === '_status') {
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex h-6 w-full items-center justify-center rounded border border-dashed hover:bg-accent">
              {mappingStatusFilter === 'all' ? (
                <span className="text-[10px] text-muted-foreground">●</span>
              ) : (
                <span className={`inline-block size-2 rounded-full ${STATUS_COLORS[mappingStatusFilter] ?? STATUS_COLORS.unmapped}`} />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-36">
            {MAPPING_STATUS_OPTIONS.map((opt) => (
              <DropdownMenuCheckboxItem
                key={opt}
                checked={mappingStatusFilter === opt}
                onCheckedChange={() => onMappingStatusFilterChange(opt)}
                className="text-xs"
              >
                <span className="flex items-center gap-2">
                  {opt !== 'all' && (
                    <span className={`inline-block size-2 rounded-full ${STATUS_COLORS[opt] ?? STATUS_COLORS.unmapped}`} />
                  )}
                  {t(`concept_mapping.filter_${opt}`)}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )
    }
    if (columnId === 'concept_id') {
      return <DebouncedInput className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="ID..." value={filters.searchId ?? ''} onChange={(v) => onFiltersChange({ ...filters, searchId: v || undefined })} />
    }
    if (columnId === 'concept_code') {
      return <DebouncedInput className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="Code..." value={filters.searchCode ?? ''} onChange={(v) => onFiltersChange({ ...filters, searchCode: v || undefined })} />
    }
    if (columnId === 'concept_name') {
      return <DebouncedInput className={FILTER_INPUT_CLASS} placeholder="..." value={filters.searchText ?? ''} onChange={(v) => onFiltersChange({ ...filters, searchText: v || undefined })} />
    }
    if (columnId === 'terminology_name') {
      const termOpts = filterOptions.terminology_name?.length ? filterOptions.terminology_name : filterOptions.vocabulary_id
      if (termOpts?.length) {
        const filterKey = filterOptions.terminology_name?.length ? 'terminologyName' : 'vocabularyId'
        const value = filterKey === 'terminologyName' ? filters.terminologyName : filters.vocabularyId
        return <MultiSelectFilter
          value={value ?? []}
          options={termOpts}
          placeholder={t('concept_mapping.col_terminology')}
          onChange={(v) => onFiltersChange({ ...filters, [filterKey]: v.length ? v : undefined })}
          popoverWidthClass="w-[360px]"
        />
      }
    }
    if (columnId === 'category' && filterOptions.category?.length > 0) {
      return <MultiSelectFilter
        value={filters.category ?? []}
        options={filterOptions.category}
        placeholder="Category"
        onChange={(v) => onFiltersChange({ ...filters, category: v.length ? v : undefined })}
        popoverWidthClass="w-[360px]"
      />
    }
    if (columnId === 'subcategory' && filterOptions.subcategory?.length > 0) {
      return <MultiSelectFilter
        value={filters.subcategory ?? []}
        options={filterOptions.subcategory}
        placeholder="Subcategory"
        onChange={(v) => onFiltersChange({ ...filters, subcategory: v.length ? v : undefined })}
        popoverWidthClass="w-[360px]"
      />
    }
    if (columnId === 'domain_id' && filterOptions.domain_id?.length > 0) {
      return <MultiSelectFilter
        value={filters.domainId ?? []}
        options={filterOptions.domain_id}
        placeholder="Domain"
        onChange={(v) => onFiltersChange({ ...filters, domainId: v.length ? v : undefined })}
      />
    }
    if (columnId === 'concept_class_id' && filterOptions.concept_class_id?.length > 0) {
      return <MultiSelectFilter
        value={filters.conceptClassId ?? []}
        options={filterOptions.concept_class_id}
        placeholder="Class"
        onChange={(v) => onFiltersChange({ ...filters, conceptClassId: v.length ? v : undefined })}
      />
    }
    return null
  }

  // Build columns dynamically based on available schema columns
  const columns = useMemo<ColumnDef<SourceConceptRow>[]>(() => {
    const cols: ColumnDef<SourceConceptRow>[] = [
      {
        id: '_status',
        header: '',
        accessorFn: () => null,
        cell: ({ row }) => {
          const cid = row.original.concept_id
          const isIgnored = ignoredConceptIds.has(cid)
          const isMapped = mappingStatusMap.has(cid)
          const isMappedElsewhere = !isMapped && mappedElsewhereIds.has(cid)
          const status = isIgnored ? 'ignored' : isMapped ? 'mapped' : isMappedElsewhere ? 'mapped_elsewhere' : 'unmapped'

          const dot = (
            <span className="flex justify-center">
              <span className={`inline-block size-2 rounded-full ${STATUS_COLORS[status] ?? STATUS_COLORS.unmapped}`} />
            </span>
          )

          // Tooltip content
          let tooltipContent: ReactNode = (
            <span className="text-xs">{t(`concept_mapping.status_tip_${status}`)}</span>
          )

          if (status === 'mapped' && projectMappings) {
            const local = projectMappings.filter((m) => m.sourceConceptId === cid)
            if (local.length > 0) {
              tooltipContent = (
                <div className="max-w-xs space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('concept_mapping.status_tip_mapped')}
                  </p>
                  {local.map((m) => {
                    const a = (m.reviews ?? []).filter((r) => r.status === 'approved').length
                    const r = (m.reviews ?? []).filter((rv) => rv.status === 'rejected').length
                    const f = (m.reviews ?? []).filter((rv) => rv.status === 'flagged').length
                    return (
                      <div key={m.id} className="space-y-0.5">
                        <p className="truncate text-xs font-medium" title={m.targetConceptName}>
                          → {m.targetConceptName || `#${m.targetConceptId}`}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {m.targetVocabularyId} · {m.equivalence?.replace('skos:', '') ?? ''}
                        </p>
                        {(a + r + f) > 0 && (
                          <p className="flex gap-2 text-[10px]">
                            {a > 0 && <span className="text-green-600">✓ {a}</span>}
                            {f > 0 && <span className="text-orange-500">⚑ {f}</span>}
                            {r > 0 && <span className="text-red-500">✗ {r}</span>}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            }
          }

          // Blue dot: mapped in other projects. Popover previews up to 5 with
          // inline import buttons + a "View full list" link to the bulk modal.
          if (status === 'mapped_elsewhere' && externalMappingsByKey) {
            const key = `${row.original.vocabulary_id ?? ''}:${row.original.concept_code ?? ''}`
            const list = externalMappingsByKey.get(key) ?? []
            if (list.length > 0) {
              const sourceLabel = row.original.concept_name
                ? `${row.original.concept_name} (${row.original.vocabulary_id ?? ''} · ${row.original.concept_code ?? ''})`
                : `${row.original.vocabulary_id ?? ''} · ${row.original.concept_code ?? ''}`
              const localSourceConceptId = row.original.concept_id
              return (
                <Popover>
                  <PopoverTrigger asChild>
                    <button type="button" className="flex w-full justify-center" onClick={(e) => e.stopPropagation()}>
                      {dot}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="right"
                    align="start"
                    className="w-[340px] border-neutral-200 bg-neutral-900 p-3 text-xs text-neutral-100 dark:border-neutral-700 dark:bg-white dark:text-neutral-900"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                      {t('concept_mapping.status_tip_mapped_elsewhere_plural', { count: list.length })}
                    </p>
                    <div className="mt-2 space-y-2">
                      {list.slice(0, 5).map((info) => {
                        const m = info.mapping
                        const a = (m.reviews ?? []).filter((rv) => rv.status === 'approved').length
                        const r = (m.reviews ?? []).filter((rv) => rv.status === 'rejected').length
                        const f = (m.reviews ?? []).filter((rv) => rv.status === 'flagged').length
                        const importKey = `${info.sourceProjectId}::${m.id}`
                        const isImporting = importingInfoIds.has(importKey)
                        const alreadyImported = !!projectMappings?.some((pm) =>
                          pm.sourceConceptId === localSourceConceptId &&
                          pm.sourceVocabularyId === m.sourceVocabularyId &&
                          pm.sourceConceptCode === m.sourceConceptCode &&
                          pm.targetConceptId === m.targetConceptId
                        )
                        return (
                          <div key={m.id} className="flex items-start gap-2 border-l-2 border-blue-400/60 pl-2">
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <p className="truncate text-xs font-medium text-neutral-100 dark:text-neutral-900" title={m.targetConceptName}>
                                → {m.targetConceptName || `#${m.targetConceptId}`}
                              </p>
                              <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
                                {info.sourceProjectName} · {m.targetVocabularyId} · {m.equivalence?.replace('skos:', '') ?? ''}
                              </p>
                              {(a + r + f) > 0 && (
                                <p className="flex gap-2 text-[10px]">
                                  {a > 0 && <span className="text-green-400 dark:text-green-600">✓ {a}</span>}
                                  {f > 0 && <span className="text-orange-400 dark:text-orange-600">⚑ {f}</span>}
                                  {r > 0 && <span className="text-red-400 dark:text-red-600">✗ {r}</span>}
                                </p>
                              )}
                            </div>
                            {alreadyImported ? (
                              <span title={t('concept_mapping.imported')} className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-green-500/40 bg-green-500/10 text-green-400 dark:text-green-600">
                                <Check size={11} />
                              </span>
                            ) : onImportExternal && (
                              <button
                                type="button"
                                title={t('concept_mapping.import_this_mapping')}
                                onClick={(e) => { e.stopPropagation(); handleImportInfo(info, localSourceConceptId, { showConfirmation: true }) }}
                                disabled={isImporting}
                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-neutral-600 bg-neutral-800 text-neutral-200 hover:bg-neutral-700 disabled:opacity-50 dark:border-neutral-300 dark:bg-neutral-100 dark:text-neutral-700 dark:hover:bg-neutral-200"
                              >
                                {isImporting ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                              </button>
                            )}
                          </div>
                        )
                      })}
                      {list.length > 5 && (
                        <p className="text-[10px] italic text-neutral-400 dark:text-neutral-500">
                          +{list.length - 5} {t('concept_mapping.status_tip_more')}
                        </p>
                      )}
                    </div>
                    {onImportExternal && (
                      <div className="mt-3 flex justify-center">
                        <Button
                          size="xs"
                          variant="outline"
                          className="h-7 gap-1 border-neutral-600 bg-neutral-800 text-[11px] text-neutral-200 hover:bg-neutral-700 hover:text-neutral-100 dark:border-neutral-300 dark:bg-neutral-100 dark:text-neutral-700 dark:hover:bg-neutral-200 dark:hover:text-neutral-900"
                          onClick={(e) => {
                            e.stopPropagation()
                            setExternalListModal({ list, sourceLabel, localSourceConceptId })
                          }}
                        >
                          <Download size={11} />
                          {list.length > 5
                            ? t('concept_mapping.status_tip_open_import_modal_with_count', { count: list.length })
                            : t('concept_mapping.status_tip_open_import_modal')}
                        </Button>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              )
            }
          }

          return (
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>{dot}</TooltipTrigger>
              <TooltipContent side="right" className="text-xs">{tooltipContent}</TooltipContent>
            </Tooltip>
          )
        },
        size: 28,
        minSize: 28,
        enableResizing: false,
      },
    ]

    // Terminology/vocabulary column (first data column)
    if (!isFileSource || fileHasTerminology) {
      cols.push({
        id: 'terminology_name',
        header: () => t('concept_mapping.col_terminology'),
        accessorFn: (row) => row.terminology_name,
        cell: ({ row }) => row.original.terminology_name || row.original.vocabulary_id || '',
        size: 110,
        minSize: 60,
      })
    }

    if (hasCategory) {
      cols.push({
        id: 'category',
        header: () => t('concept_mapping.col_category'),
        accessorFn: (row) => row.category,
        cell: ({ row }) => row.original.category ?? '',
        size: 110,
        minSize: 60,
      })
    }

    if (hasSubcategory) {
      cols.push({
        id: 'subcategory',
        header: () => t('concept_mapping.col_subcategory'),
        accessorFn: (row) => row.subcategory,
        cell: ({ row }) => row.original.subcategory ?? '',
        size: 110,
        minSize: 60,
      })
    }

    // Concept ID column.
    // - Database source: native concept_id from the source table.
    // - File source with `conceptIdColumn` mapped: native concept_id from the file.
    // - File source without conceptIdColumn: resolve via the workspace badge registry
    //   (assigned source_concept_id), or '—' if not yet assigned.
    cols.push({
      id: 'concept_id',
      header: () => t('concept_mapping.col_source_concept_id'),
      accessorFn: (row) => {
        if (isFileSourceWithoutConceptId && sourceConceptIdMap) {
          const key = `${row.vocabulary_id ?? ''}__${row.concept_code ?? ''}`
          return sourceConceptIdMap.get(key) ?? null
        }
        return row.concept_id
      },
      cell: ({ row }) => {
        if (isFileSourceWithoutConceptId) {
          const key = `${row.original.vocabulary_id ?? ''}__${row.original.concept_code ?? ''}`
          const assigned = sourceConceptIdMap?.get(key)
          return <span className="font-mono">{assigned ?? <span className="text-muted-foreground/60">—</span>}</span>
        }
        return <span className="font-mono">{row.original.concept_id}</span>
      },
      size: 90,
      minSize: 50,
    })

    cols.push({
      id: 'concept_name',
      header: () => t('concept_mapping.col_name'),
      accessorFn: (row) => row.concept_name,
      cell: ({ row }) => row.original.concept_name,
      size: 220,
      minSize: 100,
    })

    // Concept code column
    if (isFileSource) {
      cols.push({
        id: 'concept_code',
        header: () => t('concept_mapping.col_concept_code'),
        accessorFn: (row) => row.concept_code,
        cell: ({ row }) => <span className="font-mono">{row.original.concept_code ?? ''}</span>,
        size: 100,
        minSize: 60,
      })
    }

    // Count columns: always for database source, or when mapped in file source
    if (!isFileSource || hasPatientCount) {
      cols.push({
        id: 'patient_count',
        header: () => t('concept_mapping.col_patients'),
        accessorFn: (row) => row.patient_count,
        cell: ({ row }) => (
          <span className="tabular-nums">{Number(row.original.patient_count ?? 0).toLocaleString()}</span>
        ),
        size: 80,
        minSize: 50,
      })
    }
    if (!isFileSource || hasRecordCount) {
      cols.push({
        id: 'record_count',
        header: () => t('concept_mapping.col_records'),
        accessorFn: (row) => row.record_count,
        cell: ({ row }) => (
          <span className="tabular-nums">{Number(row.original.record_count ?? 0).toLocaleString()}</span>
        ),
        size: 80,
        minSize: 50,
      })
    }

    // Extra OMOP-specific columns (domain_id, concept_class_id) — hidden by default
    if (hasExtraColumns || fileHasDomain) {
      cols.push({
        id: 'domain_id',
        header: () => t('concept_mapping.col_domain_id'),
        accessorFn: (row) => row.domain_id,
        cell: ({ row }) => row.original.domain_id ?? '',
        size: 90,
        minSize: 60,
      })
    }
    if (hasExtraColumns || fileHasClass) {
      cols.push({
        id: 'concept_class_id',
        header: () => t('concept_mapping.col_concept_class'),
        accessorFn: (row) => row.concept_class_id,
        cell: ({ row }) => row.original.concept_class_id ?? '',
        size: 100,
        minSize: 60,
      })
    }

    // Info/chart column (last position) — shows chart icon if concept has info_json
    if (hasInfoJson && onShowDetail) {
      cols.push({
        id: '_info',
        header: '',
        accessorFn: () => null,
        cell: ({ row }) => {
          if (!row.original.info_json) return null
          return (
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
              title={t('concept_mapping.show_concept_stats')}
              onClick={(e) => {
                e.stopPropagation()
                onShowDetail(row.original)
              }}
            >
              <BarChart3 size={12} />
            </button>
          )
        },
        size: 28,
        minSize: 28,
        enableResizing: false,
        enableSorting: false,
      })
    }

    return cols
  }, [t, mappingStatusMap, mappedElsewhereIds, ignoredConceptIds, projectMappings, externalMappingsByKey, sourceConceptIdMap, isFileSourceWithoutConceptId, hasCategory, hasSubcategory, hasExtraColumns, isFileSource, hasRecordCount, hasPatientCount, fileHasTerminology, fileHasDomain, fileHasClass, hasInfoJson, onShowDetail, onImportExternal, importingInfoIds])

  // The mapping-status filter is now applied SQL-side by the parent. The rows
  // arriving here are already filtered, so we can hand them straight to TanStack.
  const table = useReactTable({
    data: rows,
    columns,
    state: { columnVisibility, columnSizing },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualFiltering: true,
    manualSorting: true,
  })

  // Search bar state: typed text is local and only commits to filters on Enter / button click.
  // Filters.searchTextFuzzy stays the source of truth (drives the SQL query).
  const [pendingSearch, setPendingSearch] = useState(filters.searchTextFuzzy ?? '')
  // Re-sync local input when external filter changes (e.g. cleared via reset)
  useEffect(() => { setPendingSearch(filters.searchTextFuzzy ?? '') }, [filters.searchTextFuzzy])

  const commitSearch = () => {
    const term = pendingSearch.trim()
    onFiltersChange({ ...filters, searchTextFuzzy: term || undefined })
  }
  const clearSearch = () => {
    setPendingSearch('')
    if (filters.searchTextFuzzy) onFiltersChange({ ...filters, searchTextFuzzy: undefined })
  }

  // Vocabulary filter wiring for the Filters popover — mirrors the inline
  // terminology_name column filter (prefer terminology names, fall back to vocab ids).
  const vocabOptions = filterOptions.terminology_name?.length ? filterOptions.terminology_name : filterOptions.vocabulary_id
  const vocabFilterKey = filterOptions.terminology_name?.length ? 'terminologyName' : 'vocabularyId'
  const vocabValue = (vocabFilterKey === 'terminologyName' ? filters.terminologyName : filters.vocabularyId) ?? []
  const categoryOptions = filterOptions.category ?? []
  const suggestionCategoryOptions = SUGGESTION_CATEGORIES.map((c) => ({ value: c, label: t(`concept_mapping.suggestion_category_${c}`) }))
  const activeFilterCount = vocabValue.length + (filters.category?.length ?? 0) + suggestionCategories.size

  return (
    <div className="flex h-full flex-col border-r overflow-hidden">
      {/* Search bar — fuzzy ranked search by concept_name (DuckDB jaro_winkler).
          Mirrors the target-concept panel: filter popover + input + search button. */}
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        {/* Filter popover — column filters (vocabulary, category) + suggestion category */}
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" className={`h-8 w-8 shrink-0 ${activeFilterCount > 0 ? 'text-primary' : ''}`}>
                  <SlidersHorizontal size={14} />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{t('common.filters')}</TooltipContent>
          </Tooltip>
          <PopoverContent align="start" className="w-[260px] p-3 space-y-3" onCloseAutoFocus={(e) => e.preventDefault()}>
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">{t('concept_mapping.source_filters')}</p>
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    onFiltersChange({ ...filters, terminologyName: undefined, vocabularyId: undefined, category: undefined })
                    onSuggestionCategoriesChange(new Set())
                  }}
                >
                  {t('common.clear')}
                </button>
              )}
            </div>
            {/* Vocabulary */}
            {vocabOptions?.length ? (
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_vocabulary')}</label>
                <MultiSelectFilter
                  value={vocabValue}
                  options={vocabOptions}
                  placeholder={t('concept_mapping.col_terminology')}
                  onChange={(v) => onFiltersChange({ ...filters, [vocabFilterKey]: v.length ? v : undefined })}
                  triggerClass="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus:border-primary"
                  popoverWidthClass="w-[300px]"
                />
              </div>
            ) : null}
            {/* Category */}
            {categoryOptions.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_category')}</label>
                <MultiSelectFilter
                  value={filters.category ?? []}
                  options={categoryOptions}
                  placeholder={t('concept_mapping.col_category')}
                  onChange={(v) => onFiltersChange({ ...filters, category: v.length ? v : undefined })}
                  triggerClass="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus:border-primary"
                  popoverWidthClass="w-[300px]"
                />
              </div>
            )}
            {/* Has a suggestion from */}
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.filter_by_suggestion')}</label>
              <MultiSelectFilter
                value={[...suggestionCategories]}
                options={suggestionCategoryOptions}
                placeholder={hasScores ? t('concept_mapping.filter_by_suggestion_any') : t('concept_mapping.source_filters_no_scores')}
                onChange={(v) => onSuggestionCategoriesChange(new Set(v as SuggestionCategory[]))}
                triggerClass="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus:border-primary"
                popoverWidthClass="w-[240px]"
              />
              {!hasScores && <p className="text-[10px] text-muted-foreground">{t('concept_mapping.source_filters_no_scores')}</p>}
            </div>
          </PopoverContent>
        </Popover>
        {/* Search input */}
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
            placeholder={t('concept_mapping.search_concepts')}
          />
          {pendingSearch && (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={commitSearch}>
          {t('common.search')}
        </Button>
        {/* Add selection to copy list */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="outline"
              className="h-8 w-8 shrink-0"
              disabled={selectedConceptIds.size === 0}
              onClick={onAddSelectionToList}
              aria-label={t('concept_mapping.add_to_list')}
            >
              <Plus size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {selectedConceptIds.size > 0
              ? t('concept_mapping.add_to_list_count', { count: selectedConceptIds.size })
              : t('concept_mapping.add_to_list')}
          </TooltipContent>
        </Tooltip>
        {/* Open copy list modal */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="outline"
              className="relative h-8 w-8 shrink-0"
              onClick={onOpenList}
              aria-label={t('concept_mapping.view_list')}
            >
              <List size={14} />
              {listCount > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                  {listCount}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.view_list')}</TooltipContent>
        </Tooltip>
        {filters.searchTextFuzzy && !sorting && (
          <span className="shrink-0 text-[10px] text-muted-foreground italic">
            {t('concept_mapping.sorted_by_relevance')}
          </span>
        )}
      </div>

      {/* Table */}
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto" style={{ paddingRight: 'calc(var(--spacing) * 2.5)' }}>
        <Table className="w-full" style={{ tableLayout: 'fixed' }}>
          <TableHeader>
            {/* Column titles */}
            <TableRow>
              {table.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => {
                  const colId = header.column.id
                  const isStatusCol = colId === '_status'
                  const isUnsortable = colId === '_info'
                  return (
                    <TableHead
                      key={header.id}
                      className="relative select-none overflow-hidden text-xs"
                      style={{ width: header.getSize(), maxWidth: header.getSize() }}
                    >
                      {isStatusCol || isUnsortable ? null : (
                        <button
                          type="button"
                          className="flex w-full min-w-0 items-center gap-1 overflow-hidden pr-2 hover:text-foreground"
                          onClick={() => handleSort(colId)}
                        >
                          <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </TruncatedHeader>
                          <SortIndicator columnId={colId} sorting={sorting} />
                        </button>
                      )}
                      {/* Resize handle */}
                      {header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => header.column.resetSize()}
                          className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
                        >
                          <div
                            className={`absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors ${
                              header.column.getIsResizing() ? 'bg-primary' : 'bg-transparent group-hover/resize:bg-muted-foreground/40'
                            }`}
                          />
                        </div>
                      )}
                    </TableHead>
                  )
                })
              )}
            </TableRow>
            {/* Inline column filters */}
            <TableRow className="hover:bg-transparent">
              {table.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => (
                  <TableHead
                    key={`filter-${header.id}`}
                    className="px-1 py-1"
                    style={{ width: header.getSize() }}
                  >
                    {renderColumnFilter(header.column.id)}
                  </TableHead>
                ))
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              Array.from({ length: 10 }).map((_, i) => (
                <TableRow key={i}>
                  {table.getVisibleLeafColumns().map((col) => (
                    <TableCell key={col.id}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : queryError ? (
              <TableRow>
                <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center">
                  <p className="text-xs text-destructive">{t('concept_mapping.query_error')}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">{queryError}</p>
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => {
                const cid = row.original.concept_id
                const isSelected = selectedConceptIds.size > 0
                  ? selectedConceptIds.has(cid)
                  : cid === selectedConceptId
                return (
                  <TableRow
                    key={cid}
                    className="cursor-pointer select-none"
                    data-state={isSelected ? 'selected' : undefined}
                    onClick={(e) => handleRowClick(cid, e)}
                  >
                    {row.getVisibleCells().map((cell) => {
                      // Read the registry id straight from the map rather than
                      // through getValue(): the accessor closes over the map, and
                      // TanStack caches what it returned, so a row rendered before
                      // the ids arrived keeps reporting null for the rest of the
                      // session even though the cell itself shows the id.
                      const raw = cell.column.id === 'concept_id' && isFileSourceWithoutConceptId
                        ? sourceConceptIdMap?.get(`${row.original.vocabulary_id ?? ''}__${row.original.concept_code ?? ''}`) ?? null
                        : cell.getValue()
                      // Every value-bearing column gets the tooltip, shown whether
                      // or not the text is cut: it carries the copy button, and
                      // lifting a code out of a cell is worth as much when the
                      // value happens to fit as when it does not.
                      const useTooltip = !NO_TOOLTIP_COLUMNS.has(cell.column.id) && raw != null && String(raw) !== ''
                      const rendered = useTooltip
                        ? <TruncatedText alwaysShow text={String(raw)} className={MONO_COLUMNS.has(cell.column.id) ? 'font-mono' : undefined} />
                        : flexRender(cell.column.columnDef.cell, cell.getContext())
                      return (
                        <TableCell
                          key={cell.id}
                          className="overflow-hidden truncate text-xs px-2 py-1"
                          style={{ maxWidth: cell.column.getSize() }}
                        >
                          {rendered}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Footer: count + columns on the left, paging on the right — the layout
          ConceptDataTable uses, so every table in the app reads the same. */}
      <div className="flex shrink-0 items-center justify-between border-t px-3 py-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            {totalCount.toLocaleString()} {t('concept_mapping.total_concepts')}
          </span>
          <ColumnVisibilityMenu
            trigger={
              <Button variant="ghost" size="icon-sm" className="h-6 w-6">
                <Settings2 size={12} />
              </Button>
            }
            items={table.getAllColumns()
              .filter((col) => !col.id.startsWith('_'))
              .map((col) => ({
                id: col.id,
                label: getColLabel(columns, col.id),
                visible: col.getIsVisible(),
              }))}
            onToggle={(id, visible) => table.getColumn(id)?.toggleVisibility(visible)}
            onSetMany={(ids, visible) => {
              for (const id of ids) table.getColumn(id)?.toggleVisibility(visible)
            }}
          />
        </div>

        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onPageChange(page - 1)}
              disabled={page === 0 || loading}
              aria-label={t('common.previous')}
            >
              <ChevronLeft size={14} />
            </Button>
            <span className="flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
              {loading && <Loader2 size={10} className="animate-spin" />}
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages - 1 || loading}
              aria-label={t('common.next')}
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        )}
      </div>
      {/* Bulk-list modal: every external mapping for the source row, each with
          its own Import button. After a successful import the body swaps to a
          confirmation overlay for ~1.2s, then the modal auto-closes. */}
      <Dialog
        open={!!externalListModal}
        onOpenChange={(open) => { if (!open) setExternalListModal(null) }}
      >
        <DialogContent className="sm:max-w-lg">
          {(() => {
            const hasJustImported = externalListModal?.list.some((info) =>
              justImportedIds.has(`${info.sourceProjectId}::${info.mapping.id}`)
            ) ?? false
            if (hasJustImported) {
              return (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                  <span className="flex size-10 items-center justify-center rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
                    <Check size={22} />
                  </span>
                  <p className="text-sm font-medium">{t('concept_mapping.import_confirmation')}</p>
                </div>
              )
            }
            return (
              <>
                <DialogHeader>
                  <DialogTitle>{t('concept_mapping.external_list_title')}</DialogTitle>
                  <DialogDescription className="truncate">{externalListModal?.sourceLabel}</DialogDescription>
                </DialogHeader>
                <div className="max-h-[60vh] space-y-2 overflow-auto">
                  {externalListModal?.list.map((info) => {
                    const m = info.mapping
                    const a = (m.reviews ?? []).filter((rv) => rv.status === 'approved').length
                    const r = (m.reviews ?? []).filter((rv) => rv.status === 'rejected').length
                    const f = (m.reviews ?? []).filter((rv) => rv.status === 'flagged').length
                    const importKey = `${info.sourceProjectId}::${m.id}`
                    const isImporting = importingInfoIds.has(importKey)
                    return (
                      <div key={m.id} className="flex items-start gap-2 rounded border-l-2 border-blue-400/60 bg-muted/30 p-2">
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <p className="truncate text-xs font-medium" title={m.targetConceptName}>
                            → {m.targetConceptName || `#${m.targetConceptId}`}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {info.sourceProjectName} · {m.targetVocabularyId} · {m.equivalence?.replace('skos:', '') ?? ''}
                          </p>
                          {(a + r + f) > 0 && (
                            <p className="flex gap-2 text-[10px]">
                              {a > 0 && <span className="text-green-600">✓ {a}</span>}
                              {f > 0 && <span className="text-orange-500">⚑ {f}</span>}
                              {r > 0 && <span className="text-red-500">✗ {r}</span>}
                            </p>
                          )}
                        </div>
                        {onImportExternal && (
                          <Button
                            size="xs"
                            variant="outline"
                            className="h-6 gap-1 text-[10px]"
                            disabled={isImporting}
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              const modalState = externalListModal
                              if (!modalState) return
                              handleImportInfo(info, modalState.localSourceConceptId, { closeModal: true })
                            }}
                          >
                            {isImporting ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                            {t('concept_mapping.import')}
                          </Button>
                        )}
                      </div>
                    )
                  })}
                </div>
                <DialogFooter>
                  <Button variant="outline" size="sm" onClick={() => setExternalListModal(null)}>
                    {t('common.close')}
                  </Button>
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>
      {/* Transient "Alignement importé" confirmation, auto-dismissed after 1s. */}
      <Dialog open={importConfirmationOpen} onOpenChange={setImportConfirmationOpen}>
        <DialogContent className="sm:max-w-xs" showCloseButton={false}>
          <DialogHeader className="sr-only">
            <DialogTitle>{t('concept_mapping.import_confirmation')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
              <Check size={22} />
            </span>
            <p className="text-sm font-medium">{t('concept_mapping.import_confirmation')}</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
