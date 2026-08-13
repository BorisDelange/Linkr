import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown, CheckSquare, Square } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ColumnVisibilityMenu } from '@/components/ui/column-visibility-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { MappingChange } from '@/lib/concept-mapping/merge'
import type { ConceptMapping } from '@/types'

interface PullMappingsTableProps {
  changes: MappingChange[]
  selected?: Set<string>
  conflictChoices?: Record<string, 'remote' | 'local'>
  /**
   * Scopes the remembered view (sort, filters, column widths). Closing this
   * dialog unmounts it, so without somewhere outside to keep them, reopening
   * drops a half-built filter and every resized column.
   */
  viewKey?: string
  onClose: () => void
  onApply?: (selected: Set<string>, conflictChoices: Record<string, 'remote' | 'local'>) => void
  /**
   * Review-only: no checkboxes, no Confirm — just the rows.
   *
   * Used by the push side, where the changes are already decided (they are what
   * the local content holds); the question is only "what am I about to send?".
   */
  readOnly?: boolean
}

const CHANGE_CLS: Record<MappingChange['type'], string> = {
  add: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  update: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  delete: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
  conflict: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
}

/** Flattened row: the merge change + the fields we sort/filter/display on. */
interface Row {
  key: string
  type: MappingChange['type']
  sourceName: string
  sourceCode: string
  sourceVocab: string
  targetName: string
  targetCode: string
  mappedBy: string
  // Hidden by default. An "updated" row says what changed nowhere on screen, so
  // these carry the rest of the compared fields — the answer is always in one of
  // them (a re-stamped mappedOn, a status vote, an added comment).
  targetVocab: string
  targetDomain: string
  targetStandard: string
  equivalence: string
  status: string
  mappedOn: string
  comments: string
  reviews: string
  reviewedBy: string
  reviewedOn: string
}

function toRow(c: MappingChange): Row {
  const m: ConceptMapping | null = c.remote ?? c.local
  return {
    key: c.key,
    type: c.type,
    sourceName: m?.sourceConceptName ?? '',
    sourceCode: m?.sourceConceptCode ?? '',
    sourceVocab: m?.sourceVocabularyId ?? '',
    targetName: m?.targetConceptName ?? '',
    targetCode: m?.targetConceptCode ?? '',
    mappedBy: m?.mappedBy ?? '',
    targetVocab: m?.targetVocabularyId ?? '',
    targetDomain: m?.targetDomainId ?? '',
    targetStandard: m?.targetStandardConcept ?? '',
    equivalence: m?.equivalence ?? '',
    status: m?.status ?? '',
    mappedOn: m?.mappedOn ?? '',
    // Counts, not contents: the point is spotting that a row gained a comment,
    // and the text itself would not fit a cell anyway.
    comments: m?.comments?.length ? String(m.comments.length) : '',
    reviews: m?.reviews?.length ? String(m.reviews.length) : '',
    reviewedBy: m?.reviewedBy ?? '',
    reviewedOn: m?.reviewedOn ?? '',
  }
}

type SortState = { columnId: string; desc: boolean } | null
type TypeFilter = 'all' | MappingChange['type']
const TYPE_FILTERS: TypeFilter[] = ['all', 'add', 'update', 'delete', 'conflict']

/** Columns off until asked for: they exist to explain an "updated" row, and
 *  showing all of them by default would bury the identity columns. */
const DEFAULT_HIDDEN = [
  'targetVocab', 'targetDomain', 'targetStandard', 'equivalence', 'status',
  'mappedOn', 'comments', 'reviews', 'reviewedBy', 'reviewedOn',
]

/** Plain-text labels for the visibility menu, which searches on text and so
 *  cannot use the columns' rendered headers. */
const COLUMN_LABELS = (t: (k: string) => string): Record<string, string> => ({
  type: t('versioning.pull_col_change'),
  sourceVocab: t('concept_mapping.col_source_vocabulary'),
  sourceCode: t('concept_mapping.col_source_concept_code'),
  sourceName: t('concept_mapping.col_source_concept_name'),
  targetCode: t('concept_mapping.col_target_concept_code'),
  targetName: t('concept_mapping.col_target_concept_name'),
  mappedBy: t('concept_mapping.col_mapped_by'),
  targetVocab: t('concept_mapping.col_target_vocabulary'),
  targetDomain: t('concept_mapping.col_domain'),
  targetStandard: t('concept_mapping.col_standard'),
  equivalence: t('concept_mapping.col_equivalence'),
  status: t('concept_mapping.col_status'),
  mappedOn: t('concept_mapping.col_mapped_on'),
  comments: t('concept_mapping.comments'),
  reviews: t('concept_mapping.col_reviews'),
  reviewedBy: t('concept_mapping.col_reviewed_by'),
  reviewedOn: t('concept_mapping.col_reviewed_on'),
})

/** Remembered view state, so closing and reopening lands where you left off. */
interface ViewState {
  sorting: SortState
  filters: Record<string, string>
  columnSizing: Record<string, number>
  typeFilter: TypeFilter
  hidden: string[]
}
const _viewCache = new Map<string, ViewState>()

/**
 * Full-size datatable to pick which mapping changes to pull. Uses the same table
 * engine + interaction model as the mapping tab (sortable column headers, inline
 * per-column filters, column resizing) so it feels identical — plus a checkbox
 * column, a change-type column and a per-conflict mine/theirs toggle.
 */
export function PullMappingsTable({ changes, selected, conflictChoices, viewKey, onClose, onApply, readOnly }: PullMappingsTableProps) {
  const { t } = useTranslation()
  const [sel, setSel] = useState<Set<string>>(new Set(selected))
  // Conflict resolutions are no longer editable in this table (the resolution
  // column was dropped); each conflict keeps its incoming default (remote), which
  // we pass straight back on apply.
  const [choices] = useState<Record<string, 'remote' | 'local'>>({ ...conflictChoices })
  const restored = viewKey ? _viewCache.get(viewKey) : undefined
  const [sorting, setSorting] = useState<SortState>(restored?.sorting ?? null)
  const [filters, setFilters] = useState<Record<string, string>>(restored?.filters ?? {})
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>(restored?.columnSizing ?? {})
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(restored?.typeFilter ?? 'all')
  const [hidden, setHidden] = useState<Set<string>>(new Set(restored?.hidden ?? DEFAULT_HIDDEN))

  // What the inputs show, kept apart from what the table filters on: re-filtering
  // thousands of rows on every keystroke made typing stutter. The committed value
  // trails by a beat, so a word is typed against one re-render, not one per letter.
  const [draftFilters, setDraftFilters] = useState<Record<string, string>>(restored?.filters ?? {})
  useEffect(() => {
    const id = setTimeout(() => setFilters(draftFilters), 250)
    return () => clearTimeout(id)
  }, [draftFilters])

  useEffect(() => {
    if (viewKey) _viewCache.set(viewKey, { sorting, filters, columnSizing, typeFilter, hidden: [...hidden] })
  }, [viewKey, sorting, filters, columnSizing, typeFilter, hidden])

  const allRows = useMemo(() => changes.map(toRow), [changes])

  const typeCounts = useMemo(() => {
    const c: Record<string, number> = { all: allRows.length }
    for (const r of allRows) c[r.type] = (c[r.type] ?? 0) + 1
    return c
  }, [allRows])

  // Filter (per-column, case-insensitive substring) then sort — outside TanStack,
  // matching the mapping tab's approach (TanStack owns only sizing + rendering).
  const rows = useMemo(() => {
    let out = allRows
    if (typeFilter !== 'all') out = out.filter((r) => r.type === typeFilter)
    for (const [col, val] of Object.entries(filters)) {
      const q = val.trim().toLowerCase()
      if (!q) continue
      out = out.filter((r) => String((r as unknown as Record<string, unknown>)[col] ?? '').toLowerCase().includes(q))
    }
    if (sorting) {
      const { columnId, desc } = sorting
      out = [...out].sort((a, b) => {
        const av = String((a as unknown as Record<string, unknown>)[columnId] ?? '')
        const bv = String((b as unknown as Record<string, unknown>)[columnId] ?? '')
        return desc ? bv.localeCompare(av) : av.localeCompare(bv)
      })
    }
    return out
  }, [allRows, filters, sorting, typeFilter])

  const toggle = (key: string) => {
    const next = new Set(sel)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSel(next)
  }

  const allVisibleSelected = rows.length > 0 && rows.every((r) => sel.has(r.key))
  const setAllVisible = (on: boolean) => {
    const next = new Set(sel)
    for (const r of rows) {
      if (on) next.add(r.key)
      else next.delete(r.key)
    }
    setSel(next)
  }

  const handleSort = (columnId: string) => {
    setSorting((s) => {
      if (s?.columnId === columnId) return s.desc ? { columnId, desc: false } : null
      return { columnId, desc: true }
    })
  }

  const columns = useMemo<ColumnDef<Row>[]>(() => [
    // Nothing to tick when the changes are already decided (push side).
    ...(readOnly ? [] : [{
      id: '_select',
      header: () => (
        <button className="flex w-full justify-center" onClick={() => setAllVisible(!allVisibleSelected)}>
          {allVisibleSelected ? <CheckSquare size={14} className="text-primary" /> : <Square size={14} className="text-muted-foreground" />}
        </button>
      ),
      cell: ({ row }) => (
        <button className="flex w-full justify-center" onClick={() => toggle(row.original.key)}>
          {sel.has(row.original.key) ? <CheckSquare size={14} className="text-primary" /> : <Square size={14} className="text-muted-foreground" />}
        </button>
      ),
      size: 36,
      minSize: 36,
      enableResizing: false,
    } as ColumnDef<Row>]),
    {
      id: 'type',
      header: () => t('versioning.pull_col_change'),
      cell: ({ row }) => (
        <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-bold uppercase', CHANGE_CLS[row.original.type])}>
          {t(`versioning.pull_change_${row.original.type}`)}
        </span>
      ),
      size: 90,
      minSize: 60,
    },
    { id: 'sourceVocab', header: () => t('concept_mapping.col_source_vocabulary'), cell: ({ row }) => row.original.sourceVocab, size: 100, minSize: 50 },
    { id: 'sourceCode', header: () => t('concept_mapping.col_source_concept_code'), cell: ({ row }) => row.original.sourceCode, size: 110, minSize: 50 },
    { id: 'sourceName', header: () => t('concept_mapping.col_source_concept_name'), cell: ({ row }) => row.original.sourceName, size: 220, minSize: 80 },
    { id: 'targetCode', header: () => t('concept_mapping.col_target_concept_code'), cell: ({ row }) => row.original.targetCode, size: 110, minSize: 50 },
    { id: 'targetName', header: () => t('concept_mapping.col_target_concept_name'), cell: ({ row }) => row.original.targetName, size: 220, minSize: 80 },
    { id: 'mappedBy', header: () => t('concept_mapping.col_mapped_by'), cell: ({ row }) => <span className="text-muted-foreground">{row.original.mappedBy}</span>, size: 140, minSize: 60 },
    { id: 'targetVocab', header: () => t('concept_mapping.col_target_vocabulary'), cell: ({ row }) => row.original.targetVocab, size: 100, minSize: 50 },
    { id: 'targetDomain', header: () => t('concept_mapping.col_domain'), cell: ({ row }) => row.original.targetDomain, size: 110, minSize: 50 },
    { id: 'targetStandard', header: () => t('concept_mapping.col_standard'), cell: ({ row }) => row.original.targetStandard, size: 90, minSize: 50 },
    { id: 'equivalence', header: () => t('concept_mapping.col_equivalence'), cell: ({ row }) => row.original.equivalence, size: 150, minSize: 60 },
    { id: 'status', header: () => t('concept_mapping.col_status'), cell: ({ row }) => row.original.status, size: 100, minSize: 50 },
    { id: 'mappedOn', header: () => t('concept_mapping.col_mapped_on'), cell: ({ row }) => <span className="text-muted-foreground">{row.original.mappedOn}</span>, size: 170, minSize: 60 },
    { id: 'comments', header: () => t('concept_mapping.comments'), cell: ({ row }) => <span className="text-muted-foreground">{row.original.comments}</span>, size: 90, minSize: 50 },
    { id: 'reviews', header: () => t('concept_mapping.col_reviews'), cell: ({ row }) => <span className="text-muted-foreground">{row.original.reviews}</span>, size: 90, minSize: 50 },
    { id: 'reviewedBy', header: () => t('concept_mapping.col_reviewed_by'), cell: ({ row }) => <span className="text-muted-foreground">{row.original.reviewedBy}</span>, size: 140, minSize: 60 },
    { id: 'reviewedOn', header: () => t('concept_mapping.col_reviewed_on'), cell: ({ row }) => <span className="text-muted-foreground">{row.original.reviewedOn}</span>, size: 170, minSize: 60 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, sel, allVisibleSelected])

  const columnVisibility = useMemo(
    () => Object.fromEntries([...hidden].map((id) => [id, false])),
    [hidden],
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { columnSizing, columnVisibility },
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
  })

  // Every column except the checkbox, which is the row's control, not data.
  const toggleableColumns = useMemo(
    () => columns
      .map((c) => c.id!)
      .filter((id) => id !== '_select')
      .map((id) => ({ id, label: COLUMN_LABELS(t)[id] ?? id, visible: !hidden.has(id) })),
    [columns, hidden, t],
  )

  const setColumnVisible = (id: string, visible: boolean) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (visible) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const NON_SORTABLE = new Set(['_select'])
  const NON_FILTERABLE = new Set(['_select'])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] w-[97vw] max-w-[1500px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1500px]">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="text-sm">
            {t(readOnly ? 'versioning.push_mappings_review' : 'versioning.pull_mappings_pick')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          {/* Change type is the first cut anyone makes on a pull ("what is new?",
              "what conflicts?"), so it sits here rather than as a column filter.
              A type with nothing in it is disabled rather than hidden, so the
              row of buttons does not reshuffle between pulls. */}
          <div className="flex items-center gap-1">
            {TYPE_FILTERS.map((tf) => {
              const count = typeCounts[tf] ?? 0
              return (
                <button
                  key={tf}
                  disabled={count === 0 && tf !== 'all'}
                  onClick={() => setTypeFilter(tf)}
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px] transition-colors',
                    typeFilter === tf ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                    count === 0 && tf !== 'all' && 'opacity-40 hover:bg-transparent',
                  )}
                >
                  {t(`versioning.pull_filter_${tf}`)}
                  <span className="ml-1 tabular-nums opacity-70">{count}</span>
                </button>
              )
            })}
          </div>
          <span className="ml-auto text-[11px] text-muted-foreground">{t('versioning.pull_selected_count', { count: sel.size, total: changes.length })}</span>
          <ColumnVisibilityMenu
            items={toggleableColumns}
            onToggle={setColumnVisible}
            onSetMany={(ids, visible) => setHidden((prev) => {
              const next = new Set(prev)
              for (const id of ids) {
                if (visible) next.delete(id)
                else next.add(id)
              }
              return next
            })}
            align="end"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <Table className="w-full" style={{ tableLayout: 'fixed' }}>
            <TableHeader>
              <TableRow>
                {table.getHeaderGroups()[0].headers.map((header) => {
                  const colId = header.column.id
                  const sortable = !NON_SORTABLE.has(colId)
                  const icon = !sorting || sorting.columnId !== colId
                    ? <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
                    : sorting.desc ? <ArrowDown size={10} className="shrink-0 text-primary" /> : <ArrowUp size={10} className="shrink-0 text-primary" />
                  return (
                    <TableHead key={header.id} className="relative select-none overflow-hidden text-xs" style={{ width: header.getSize(), maxWidth: header.getSize() }}>
                      {sortable ? (
                        <button type="button" className="flex w-full min-w-0 items-center gap-1 overflow-hidden hover:text-foreground" onClick={() => handleSort(colId)}>
                          <span className="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                          {icon}
                        </button>
                      ) : (
                        <span className="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                      )}
                      {header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => header.column.resetSize()}
                          className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
                        >
                          <div className={cn('absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors', header.column.getIsResizing() ? 'bg-primary' : 'bg-transparent group-hover/resize:bg-muted-foreground/40')} />
                        </div>
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
              {/* Per-column filter inputs */}
              <TableRow>
                {table.getHeaderGroups()[0].headers.map((header) => {
                  const colId = header.column.id
                  return (
                    <TableHead key={header.id} className="overflow-hidden p-1" style={{ width: header.getSize(), maxWidth: header.getSize() }}>
                      {!NON_FILTERABLE.has(colId) && (
                        <input
                          value={draftFilters[colId] ?? ''}
                          onChange={(e) => setDraftFilters((f) => ({ ...f, [colId]: e.target.value }))}
                          placeholder={t('common.filter')}
                          className="h-6 w-full rounded border bg-background px-1 text-[11px]"
                        />
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.original.key} className={cn(sel.has(row.original.key) && 'bg-muted/40')}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="overflow-hidden truncate text-xs" style={{ width: cell.column.getSize(), maxWidth: cell.column.getSize() }} title={String((cell.row.original as unknown as Record<string, unknown>)[cell.column.id] ?? '')}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
          {readOnly ? (
            <Button size="sm" onClick={onClose}>{t('common.close')}</Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
              <Button size="sm" onClick={() => onApply?.(sel, choices)}>{t('common.confirm')}</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
