import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  Search, Check, Flag, X, MessageSquare,
  ChevronLeft, ChevronRight, Pencil, Trash2, Square, CheckSquare,
  Settings2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import type { MappingProject, ConceptMapping, MappingStatus } from '@/types'

interface MappingsTabProps {
  project: MappingProject
}

const PAGE_SIZE = 50

// ─── Status badge styling ────────────────────────────────────────────

const STATUS_BADGE: Record<MappingStatus, string> = {
  unchecked: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  flagged: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400',
  invalid: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400',
  ignored: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
}

// ─── Equivalence short labels ────────────────────────────────────────

const EQUIV_SHORT: Record<string, string> = {
  'skos:exactMatch': 'Exact',
  'skos:closeMatch': 'Close',
  'skos:broadMatch': 'Broad',
  'skos:narrowMatch': 'Narrow',
  'skos:relatedMatch': 'Related',
  equal: 'Exact', equivalent: 'Close', wider: 'Broad', narrower: 'Narrow', inexact: 'Related',
}

/** Get human-readable label for a TanStack column def. */
function getColLabel(colDefs: ColumnDef<ConceptMapping>[], id: string): string {
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

export function MappingsTab({ project }: MappingsTabProps) {
  const { t } = useTranslation()
  const { mappings, updateMapping, deleteMapping } = useConceptMappingStore()

  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const [editMode, setEditMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})

  const projectMappings = mappings.filter((m) => m.projectId === project.id)

  const filtered = filter.trim()
    ? projectMappings.filter((m) => {
        const q = filter.toLowerCase()
        return (
          m.sourceConceptName.toLowerCase().includes(q) ||
          m.targetConceptName.toLowerCase().includes(q) ||
          String(m.sourceConceptId).includes(q) ||
          String(m.targetConceptId).includes(q) ||
          m.sourceVocabularyId.toLowerCase().includes(q) ||
          m.targetVocabularyId.toLowerCase().includes(q) ||
          m.status.includes(q) ||
          m.equivalence.includes(q)
        )
      })
    : projectMappings

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const handleFilterChange = (value: string) => {
    setFilter(value)
    setPage(0)
  }

  const toggleEditMode = () => {
    setEditMode(!editMode)
    setSelected(new Set())
  }

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = () => {
    const pageIds = pageItems.map((m) => m.id)
    const allSelected = pageIds.every((id) => selected.has(id))
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        for (const id of pageIds) next.delete(id)
      } else {
        for (const id of pageIds) next.add(id)
      }
      return next
    })
  }

  const handleDeleteSelected = () => {
    for (const id of selected) deleteMapping(id)
    setSelected(new Set())
  }

  /** Toggle review: clicking the same status resets to unchecked. */
  const handleReview = useCallback((mappingId: string, current: MappingStatus, target: MappingStatus) => {
    updateMapping(mappingId, { status: current === target ? 'unchecked' : target })
  }, [updateMapping])

  const pageAllSelected = pageItems.length > 0 && pageItems.every((m) => selected.has(m.id))

  // Build TanStack columns
  const columns = useMemo<ColumnDef<ConceptMapping>[]>(() => {
    const cols: ColumnDef<ConceptMapping>[] = []

    // Edit mode checkbox column
    if (editMode) {
      cols.push({
        id: '_select',
        header: () => (
          <button onClick={toggleSelectAll} className="flex justify-center">
            {pageAllSelected
              ? <CheckSquare size={14} className="text-foreground" />
              : <Square size={14} />}
          </button>
        ),
        cell: ({ row }) => (
          <button
            onClick={(e) => { e.stopPropagation(); toggleSelect(row.original.id) }}
            className="flex justify-center"
          >
            {selected.has(row.original.id)
              ? <CheckSquare size={14} className="text-foreground" />
              : <Square size={14} className="text-muted-foreground" />}
          </button>
        ),
        size: 32,
        minSize: 32,
        enableHiding: false,
        enableResizing: false,
      })
    }

    cols.push(
      {
        id: 'sourceConceptName',
        header: () => t('concept_mapping.col_source'),
        accessorFn: (row) => row.sourceConceptName,
        cell: ({ row }) => row.original.sourceConceptName,
        size: 200,
        minSize: 100,
        enableHiding: false,
      },
      {
        id: 'sourceConceptId',
        header: 'Source ID',
        accessorFn: (row) => row.sourceConceptId,
        cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.sourceConceptId}</span>,
        size: 70,
        minSize: 50,
      },
      {
        id: 'sourceVocabularyId',
        header: () => t('concept_mapping.col_source') + ' Vocab',
        accessorFn: (row) => row.sourceVocabularyId,
        cell: ({ row }) => row.original.sourceVocabularyId,
        size: 80,
        minSize: 50,
      },
      {
        id: 'sourceDomainId',
        header: () => t('concept_mapping.col_source') + ' Domain',
        accessorFn: (row) => row.sourceDomainId,
        cell: ({ row }) => row.original.sourceDomainId,
        size: 90,
        minSize: 50,
      },
      {
        id: 'targetConceptName',
        header: () => t('concept_mapping.col_target'),
        accessorFn: (row) => row.targetConceptName,
        cell: ({ row }) => {
          const m = row.original
          return (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{m.targetConceptName}</span>
              {m.comment && <span title={m.comment}><MessageSquare size={10} className="shrink-0 text-muted-foreground" /></span>}
            </span>
          )
        },
        size: 200,
        minSize: 100,
        enableHiding: false,
      },
      {
        id: 'targetConceptId',
        header: 'Target ID',
        accessorFn: (row) => row.targetConceptId,
        cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.targetConceptId}</span>,
        size: 70,
        minSize: 50,
      },
      {
        id: 'targetVocabularyId',
        header: () => t('concept_mapping.col_vocab'),
        accessorFn: (row) => row.targetVocabularyId,
        cell: ({ row }) => row.original.targetVocabularyId,
        size: 80,
        minSize: 50,
      },
      {
        id: 'targetDomainId',
        header: () => t('concept_mapping.col_target') + ' Domain',
        accessorFn: (row) => row.targetDomainId,
        cell: ({ row }) => row.original.targetDomainId,
        size: 90,
        minSize: 50,
      },
      {
        id: 'status',
        header: () => t('concept_mapping.col_status'),
        accessorFn: (row) => row.status,
        cell: ({ row }) => (
          <Badge
            variant="secondary"
            className={`px-1.5 py-0 text-[9px] font-medium ${STATUS_BADGE[row.original.status] ?? ''}`}
          >
            {t(`concept_mapping.status_${row.original.status}`)}
          </Badge>
        ),
        size: 80,
        minSize: 60,
        enableHiding: false,
      },
      {
        id: 'equivalence',
        header: () => t('concept_mapping.col_equiv'),
        accessorFn: (row) => row.equivalence,
        cell: ({ row }) => (
          <span className="text-[10px] text-muted-foreground">
            {EQUIV_SHORT[row.original.equivalence] ?? row.original.equivalence}
          </span>
        ),
        size: 70,
        minSize: 50,
      },
      {
        id: 'mappingType',
        header: 'Type',
        accessorFn: (row) => row.mappingType,
        cell: ({ row }) => (
          <span className="text-[10px] text-muted-foreground">
            {row.original.mappingType}
          </span>
        ),
        size: 90,
        minSize: 50,
      },
    )

    // Review action buttons (only in review mode)
    if (!editMode) {
      cols.push({
        id: '_review',
        header: () => <span className="text-right w-full block">{t('concept_mapping.col_review')}</span>,
        cell: ({ row }) => {
          const m = row.original
          return (
            <span className="flex justify-end gap-1 opacity-0 group-hover:opacity-100">
              <Button
                variant={m.status === 'approved' ? 'default' : 'outline'}
                size="icon-sm"
                className={`size-6 ${m.status === 'approved' ? 'bg-green-600 text-white hover:bg-green-700' : 'hover:border-green-600 hover:text-green-600'}`}
                title={t('concept_mapping.approve')}
                onClick={(e) => { e.stopPropagation(); handleReview(m.id, m.status, 'approved') }}
              >
                <Check size={13} />
              </Button>
              <Button
                variant={m.status === 'rejected' ? 'default' : 'outline'}
                size="icon-sm"
                className={`size-6 ${m.status === 'rejected' ? 'bg-red-600 text-white hover:bg-red-700' : 'hover:border-red-600 hover:text-red-600'}`}
                title={t('concept_mapping.reject')}
                onClick={(e) => { e.stopPropagation(); handleReview(m.id, m.status, 'rejected') }}
              >
                <X size={13} />
              </Button>
              <Button
                variant={m.status === 'flagged' ? 'default' : 'outline'}
                size="icon-sm"
                className={`size-6 ${m.status === 'flagged' ? 'bg-orange-500 text-white hover:bg-orange-600' : 'hover:border-orange-500 hover:text-orange-500'}`}
                title={t('concept_mapping.flag')}
                onClick={(e) => { e.stopPropagation(); handleReview(m.id, m.status, 'flagged') }}
              >
                <Flag size={13} />
              </Button>
            </span>
          )
        },
        size: 100,
        minSize: 100,
        enableHiding: false,
        enableResizing: false,
      })
    }

    return cols
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, editMode, selected, pageAllSelected, handleReview, toggleSelect])

  const table = useReactTable({
    data: pageItems,
    columns,
    state: { columnVisibility, columnSizing },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: totalPages,
  })

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <div className="relative max-w-sm flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder={t('concept_mapping.mappings_filter')}
            value={filter}
            onChange={(e) => handleFilterChange(e.target.value)}
          />
        </div>
        <div className="ml-auto flex items-center gap-1">
          {editMode && selected.size > 0 && (
            <Button variant="destructive" size="sm" className="h-7 gap-1 text-xs" onClick={() => setShowDeleteConfirm(true)}>
              <Trash2 size={12} />
              {t('concept_mapping.delete_selected', { count: selected.size })}
            </Button>
          )}
          <Button
            variant={editMode ? 'default' : 'outline'}
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={toggleEditMode}
          >
            <Pencil size={12} />
            {editMode ? t('concept_mapping.done_editing') : t('concept_mapping.edit_mode')}
          </Button>
          {/* Column visibility toggle */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                <Settings2 size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[180px]">
              <DropdownMenuLabel className="text-xs">{t('concepts.column_visibility', 'Columns')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {table.getAllColumns()
                .filter((col) => col.getCanHide())
                .map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.id}
                    checked={col.getIsVisible()}
                    onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                    onSelect={(e) => e.preventDefault()}
                    className="text-xs"
                  >
                    {getColLabel(columns, col.id)}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table className="w-full" style={{ tableLayout: 'fixed' }}>
          <TableHeader>
            <TableRow>
              {table.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="relative select-none text-xs"
                    style={{ width: header.getSize() }}
                  >
                    <span className="truncate">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </span>
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
                ))
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center text-sm text-muted-foreground">
                  {projectMappings.length === 0
                    ? t('concept_mapping.prog_empty')
                    : t('common.no_results')}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.original.id}
                  className="group"
                  data-state={selected.has(row.original.id) ? 'selected' : undefined}
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
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex shrink-0 items-center justify-between border-t px-4 py-1.5">
        <span className="text-[10px] text-muted-foreground">
          {filtered.length} {t('concept_mapping.existing_mappings').toLowerCase()}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            <ChevronLeft size={14} />
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {page + 1} / {totalPages}
          </span>
          <Button variant="ghost" size="icon-sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.delete_confirm_desc', { count: selected.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteSelected}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
