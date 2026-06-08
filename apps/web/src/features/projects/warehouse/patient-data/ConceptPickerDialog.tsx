import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ColumnVisibilityMenu } from '@/components/ui/column-visibility-menu'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Settings2,
} from 'lucide-react'
import { usePatientChartContext } from './PatientChartContext'
import { ConceptStatsPopover } from './ConceptStatsPopover'
import { useConcepts, type ConceptRow } from '../concepts/use-concepts'
import type { ConceptSorting } from '../concepts/concept-queries'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import type { PluginConfigField } from '@/types/plugin'
import { cn } from '@/lib/utils'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { COLOR_PALETTE } from '@/components/ui/color-picker-popover'
import { StandardConceptBadge } from '@/lib/concept-mapping/standard-concept-badge'

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

// Columns the picker hides by default — heavy OMOP detail kept one click away.
const DEFAULT_HIDDEN_COLUMNS = new Set(['domain_id', 'concept_class_id', '_dict_key'])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function columnLabel(id: string): string {
  return id
    .replace(/^_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function SortIndicator({ columnId, sorting }: { columnId: string; sorting: ConceptSorting | null }) {
  if (!sorting || sorting.columnId !== columnId) {
    return <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
  }
  if (sorting.desc) {
    return <ArrowDown size={10} className="shrink-0 text-primary" />
  }
  return <ArrowUp size={10} className="shrink-0 text-primary" />
}

function ColumnFilterSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string | null
  options: string[]
  placeholder: string
  onChange: (v: string | null) => void
}) {
  const { t } = useTranslation()
  return (
    <Select
      value={value ?? '__all__'}
      onValueChange={(v) => onChange(v === '__all__' ? null : v)}
    >
      <SelectTrigger className="h-6 w-full border-dashed text-[10px] font-normal">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">{t('concepts.filter_all')}</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt} value={opt} className="text-xs">{opt}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Compact swatch-only color picker for a selected concept, reusing the shared
 * COLOR_PALETTE so colors match the dashboard plugins. `value` is a palette
 * name or hex; `null`/undefined means "auto" (rotating default palette).
 */
function ConceptColorSwatch({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (color: string | undefined) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const entry = value ? COLOR_PALETTE.find((c) => c.name === value) : undefined
  const isHex = value?.startsWith('#')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="size-4 shrink-0 rounded-full border border-border"
          style={isHex ? { backgroundColor: value } : undefined}
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
  const { t } = useTranslation()
  const { dataSourceId, schemaMapping } = usePatientChartContext()

  const [activeTab, setActiveTab] = useState<'settings' | 'concepts'>('settings')

  // Local selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  // Selected concept names cache (to display names in the right panel)
  const [selectedNames, setSelectedNames] = useState<Map<number, string>>(new Map())

  // Local schema-driven settings (everything except conceptIds)
  const [settings, setSettings] = useState<Record<string, unknown>>({})

  // Reuse the concepts hook for full-featured data table
  const hook = useConcepts(open ? dataSourceId : undefined, open ? schemaMapping : undefined)

  // Dict key for the stats popover (multi-dict picks the row's own).
  const dicts = schemaMapping?.conceptTables ?? []

  // Sync from props when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedIds(new Set((config.conceptIds as number[]) ?? []))
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

  const toggleConcept = useCallback((conceptId: number, conceptName: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(conceptId)) {
        next.delete(conceptId)
      } else {
        next.add(conceptId)
      }
      return next
    })
    setSelectedNames((prev) => {
      const next = new Map(prev)
      next.set(conceptId, conceptName)
      return next
    })
  }, [])

  const removeConcept = useCallback((conceptId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(conceptId)
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  // Select / deselect all currently-visible rows
  const allVisibleSelected =
    hook.concepts.length > 0 &&
    hook.concepts.every((c) => selectedIds.has(c.concept_id))

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      const everyVisibleSelected =
        hook.concepts.length > 0 &&
        hook.concepts.every((c) => next.has(c.concept_id))
      if (everyVisibleSelected) {
        for (const c of hook.concepts) next.delete(c.concept_id)
      } else {
        for (const c of hook.concepts) next.add(c.concept_id)
      }
      return next
    })
    setSelectedNames((prev) => {
      const next = new Map(prev)
      for (const c of hook.concepts) next.set(c.concept_id, c.concept_name)
      return next
    })
  }, [hook.concepts])

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

  // TanStack table setup with checkbox column
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})

  // Default-hide heavy OMOP columns the first time they appear.
  // Keyed by the stable column-id string (not the array identity, which the
  // hook recreates each render) and returns the previous state untouched when
  // nothing changes, so this never loops.
  const availableColumnKey = hook.availableColumns.map((c) => c.id).join('|')
  useEffect(() => {
    setColumnVisibility((prev) => {
      let changed = false
      const next = { ...prev }
      for (const col of hook.availableColumns) {
        if (DEFAULT_HIDDEN_COLUMNS.has(col.id) && !(col.id in next)) {
          next[col.id] = false
          changed = true
        }
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableColumnKey])

  const columns = useMemo<ColumnDef<ConceptRow>[]>(() => {
    // Checkbox column
    const checkboxCol: ColumnDef<ConceptRow> = {
      id: '_select',
      header: () => null,
      cell: ({ row }) => {
        const isSelected = selectedIds.has(row.original.concept_id)
        return (
          <div
            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
              isSelected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-muted-foreground/30'
            }`}
          >
            {isSelected && <Check size={10} />}
          </div>
        )
      },
      size: 36,
      minSize: 36,
    }

    // Data columns from availableColumns
    const dataCols: ColumnDef<ConceptRow>[] = hook.availableColumns.map((col) => {
      const base: Partial<ColumnDef<ConceptRow>> = {
        id: col.id,
        header: () => columnLabel(col.id),
      }

      switch (col.id) {
        case 'concept_id':
          return {
            ...base,
            accessorFn: (row) => row.concept_id,
            cell: ({ row }) => <span className="font-mono">{row.original.concept_id}</span>,
            size: 80,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        case 'concept_name':
          return {
            ...base,
            accessorFn: (row) => row.concept_name,
            cell: ({ row }) => row.original.concept_name,
            size: 250,
            minSize: 120,
          } as ColumnDef<ConceptRow>

        case 'concept_code':
          return {
            ...base,
            accessorFn: (row) => row.concept_code,
            cell: ({ row }) => <span className="font-mono">{String(row.original.concept_code ?? '')}</span>,
            size: 100,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        case 'record_count':
          return {
            ...base,
            header: () => t('concepts.column_records'),
            accessorFn: (row) => row.record_count,
            cell: ({ row }) => (
              <span className="tabular-nums">
                {Number(row.original.record_count ?? 0).toLocaleString()}
              </span>
            ),
            size: 90,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        case 'patient_count':
          return {
            ...base,
            header: () => t('concepts.column_patients'),
            accessorFn: (row) => row.patient_count,
            cell: ({ row }) => (
              <span className="tabular-nums">
                {Number(row.original.patient_count ?? 0).toLocaleString()}
              </span>
            ),
            size: 90,
            minSize: 60,
          } as ColumnDef<ConceptRow>

        case 'standard_concept':
          return {
            ...base,
            header: () => t('concepts.column_standard', 'Standard'),
            accessorFn: (row) => row.standard_concept,
            cell: ({ row }) => (
              <StandardConceptBadge value={row.original.standard_concept as string | null | undefined} />
            ),
            size: 70,
            minSize: 48,
          } as ColumnDef<ConceptRow>

        default: {
          // Per-column widths mirroring the concept-mapping target table:
          // short codes (vocabulary/domain/class) stay narrow.
          const widthById: Record<string, number> = {
            vocabulary_id: 90,
            domain_id: 80,
            concept_class_id: 90,
          }
          return {
            ...base,
            accessorFn: (row) => row[col.id],
            cell: ({ row }) => String(row.original[col.id] ?? ''),
            size: widthById[col.id] ?? 110,
            minSize: 50,
          } as ColumnDef<ConceptRow>
        }
      }
    })

    // Metadata / distribution trigger — pinned as the last column.
    const metaCol: ColumnDef<ConceptRow> = {
      id: '_meta',
      header: () => null,
      enableHiding: false,
      cell: ({ row }) => {
        const dictKey = (row.original._dict_key as string) ?? dicts[0]?.key ?? ''
        return (
          <div className="flex justify-center">
            <ConceptStatsPopover
              dataSourceId={dataSourceId}
              schemaMapping={schemaMapping}
              conceptId={row.original.concept_id}
              dictKey={dictKey}
            />
          </div>
        )
      },
      size: 36,
      minSize: 36,
    }

    return [checkboxCol, ...dataCols, metaCol]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hook.availableColumns, selectedIds, t, dataSourceId, schemaMapping])

  const table = useReactTable({
    data: hook.concepts,
    columns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualFiltering: true,
    manualSorting: true,
    pageCount: hook.totalPages,
  })

  const visibilityItems = useMemo(
    () =>
      table
        .getAllColumns()
        .filter((col) => col.getCanHide() && col.id !== '_select')
        .map((col) => ({
          id: col.id,
          label: columnLabel(col.id),
          visible: col.getIsVisible(),
        })),
    [table, columnVisibility],
  )

  // Render inline filter for a column
  const renderColumnFilter = (columnId: string) => {
    if (columnId === '_select') return null

    if (columnId === 'concept_id') {
      return (
        <input
          className="h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] font-mono outline-none placeholder:text-muted-foreground focus:border-primary"
          placeholder="ID..."
          value={hook.filters._searchId ?? ''}
          onChange={(e) => hook.updateFilter('_searchId', e.target.value || null)}
        />
      )
    }
    if (columnId === 'concept_name') {
      return (
        <input
          className="h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary"
          placeholder={t('concepts.search_placeholder')}
          value={hook.filters._searchText ?? ''}
          onChange={(e) => hook.updateFilter('_searchText', e.target.value || null)}
        />
      )
    }
    if (columnId === 'concept_code') {
      return (
        <input
          className="h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] font-mono outline-none placeholder:text-muted-foreground focus:border-primary"
          placeholder="Code..."
          value={hook.filters._searchCode ?? ''}
          onChange={(e) => hook.updateFilter('_searchCode', e.target.value || null)}
        />
      )
    }

    const col = hook.availableColumns.find((c) => c.id === columnId)
    if (col?.filterable && hook.filterOptions[columnId]?.length) {
      return (
        <ColumnFilterSelect
          value={hook.filters[columnId] as string | null}
          options={hook.filterOptions[columnId]}
          placeholder={columnLabel(columnId)}
          onChange={(v) => hook.updateFilter(columnId, v)}
        />
      )
    }

    return null
  }

  // Sorted selected concepts for display
  const selectedList = useMemo(() => {
    return [...selectedIds].map((id) => ({
      id,
      name: selectedNames.get(id) ?? `#${id}`,
    }))
  }, [selectedIds, selectedNames])

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
        <DialogHeader className="shrink-0 border-b px-6 py-4">
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
              {selectedIds.size}
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
              {/* Column visibility toggle */}
              <div className="flex items-center justify-end border-b px-3 py-1.5">
                <ColumnVisibilityMenu
                  items={visibilityItems}
                  onToggle={(id, visible) =>
                    table.getColumn(id)?.toggleVisibility(visible)
                  }
                  onSetMany={(ids, visible) =>
                    ids.forEach((id) => table.getColumn(id)?.toggleVisibility(visible))
                  }
                  align="end"
                  trigger={
                    <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                      <Settings2 size={12} />
                      {t('common.columns')}
                    </Button>
                  }
                />
              </div>

              {/* Table */}
              <div className="min-h-0 flex-1 overflow-auto px-3">
                <Table className="w-full" style={{ tableLayout: 'fixed' }}>
                  <TableHeader>
                    {/* Column titles */}
                    <TableRow>
                      {table.getHeaderGroups().map((headerGroup) =>
                        headerGroup.headers.map((header) => (
                          <TableHead
                            key={header.id}
                            className="select-none text-xs"
                            style={{ width: header.getSize() }}
                          >
                            {header.column.id === '_select' ? (
                              <button
                                type="button"
                                className="flex h-4 w-4 items-center justify-center rounded border border-muted-foreground/30 hover:border-primary"
                                onClick={toggleSelectAllVisible}
                                title={t('common.select_all')}
                              >
                                {allVisibleSelected && <Check size={10} className="text-primary" />}
                              </button>
                            ) : header.column.id === '_meta' ? null : (
                              <button
                                type="button"
                                className="flex min-w-0 items-center gap-1 hover:text-foreground"
                                onClick={() => hook.updateSorting(header.column.id)}
                              >
                                <span className="truncate">
                                  {flexRender(header.column.columnDef.header, header.getContext())}
                                </span>
                                <SortIndicator columnId={header.column.id} sorting={hook.sorting} />
                              </button>
                            )}
                          </TableHead>
                        )),
                      )}
                    </TableRow>
                    {/* Inline filters row */}
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
                        )),
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {hook.isLoading ? (
                      Array.from({ length: 10 }).map((_, i) => (
                        <TableRow key={i}>
                          {table.getVisibleLeafColumns().map((col) => (
                            <TableCell key={col.id}>
                              <Skeleton className="h-4 w-full" />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : table.getRowModel().rows.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={table.getVisibleLeafColumns().length}
                          className="h-24 text-center text-sm text-muted-foreground"
                        >
                          {t('patient_data.no_concepts_found')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      table.getRowModel().rows.map((row) => {
                        const isSelected = selectedIds.has(row.original.concept_id)
                        return (
                          <TableRow
                            key={row.original.concept_id}
                            className="group cursor-pointer"
                            data-state={isSelected ? 'selected' : undefined}
                            onClick={() =>
                              toggleConcept(row.original.concept_id, row.original.concept_name)
                            }
                          >
                            {row.getVisibleCells().map((cell) => {
                              const rendered = flexRender(cell.column.columnDef.cell, cell.getContext())
                              const raw = cell.getValue()
                              const title = raw != null ? String(raw) : undefined
                              return (
                                <TableCell
                                  key={cell.id}
                                  className="overflow-hidden truncate text-xs"
                                  style={{ maxWidth: cell.column.getSize() }}
                                  title={title}
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

              {/* Pagination bar */}
              <div className="flex shrink-0 items-center justify-between border-t px-3 py-2">
                <span className="text-xs text-muted-foreground">
                  {t('concepts.pagination_total', { count: hook.totalCount })}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t('concepts.pagination_per_page')}
                  </span>
                  <Select
                    value={String(hook.pageSize)}
                    onValueChange={(v) => hook.setPageSize(Number(v))}
                  >
                    <SelectTrigger className="h-7 w-[70px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10</SelectItem>
                      <SelectItem value="25">25</SelectItem>
                      <SelectItem value="50">50</SelectItem>
                      <SelectItem value="100">100</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    {t('concepts.pagination_page', {
                      page: hook.page + 1,
                      total: hook.totalPages,
                    })}
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    disabled={hook.page === 0}
                    onClick={() => hook.setPage(hook.page - 1)}
                  >
                    <ChevronLeft size={14} />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    disabled={hook.page >= hook.totalPages - 1}
                    onClick={() => hook.setPage(hook.page + 1)}
                  >
                    <ChevronRight size={14} />
                  </Button>
                </div>
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
                  {selectedIds.size}
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
                      {selectedList.map((item) => (
                        <div
                          key={item.id}
                          className="group flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-accent/50"
                        >
                          <button
                            type="button"
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-primary bg-primary text-primary-foreground"
                            onClick={() => removeConcept(item.id)}
                            title={t('patient_data.remove')}
                          >
                            <Check size={10} />
                          </button>
                          <ConceptColorSwatch
                            value={conceptColors[String(item.id)]}
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
            {t('common.confirm')} ({selectedIds.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
