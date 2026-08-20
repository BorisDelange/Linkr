import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckSquare, Square } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
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

/** Rows mounted at once. Handing the table a few thousand rows is what made this
 *  dialog crawl — 3973 changes × up to 17 cells is ~60k DOM nodes, paid on open
 *  and again on every filter keystroke. */
const PAGE_SIZE = 100

type TypeFilter = 'all' | MappingChange['type']
const TYPE_FILTERS: TypeFilter[] = ['all', 'add', 'update', 'delete', 'conflict']

/** The one piece of view state the table cannot remember for us: its control
 *  lives above the table, so `viewKey` — which covers sort, filters, sizes,
 *  order and visibility — never sees it. Same key, same lifetime. */
const typeFilterCache = new Map<string, TypeFilter>()

/**
 * Full-size datatable to pick which mapping changes to pull. Built on the shared
 * `ConceptDataTable` — the same engine and interaction model as the mapping tab
 * and its twin `PullConceptsDialog` (sortable headers, inline per-column filters,
 * column resizing and a visibility menu) — plus a checkbox column, a change-type
 * column and an out-of-table change-type filter.
 */
export function PullMappingsTable({ changes, selected, conflictChoices, viewKey, onClose, onApply, readOnly }: PullMappingsTableProps) {
  const { t } = useTranslation()
  const [sel, setSel] = useState<Set<string>>(() => new Set(selected))
  // Conflict resolutions are no longer editable in this table (the resolution
  // column was dropped); each conflict keeps its incoming default (remote), which
  // we pass straight back on apply.
  const [choices] = useState<Record<string, 'remote' | 'local'>>({ ...conflictChoices })
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(
    () => (viewKey ? typeFilterCache.get(viewKey) : undefined) ?? 'all',
  )
  const pickType = (tf: TypeFilter) => {
    setTypeFilter(tf)
    if (viewKey) typeFilterCache.set(viewKey, tf)
  }
  // The rows left by the table's own filters: select-all must act on what is shown.
  const [visible, setVisible] = useState<Row[]>([])

  const allRows = useMemo(() => changes.map(toRow), [changes])

  const typeCounts = useMemo(() => {
    const c: Record<string, number> = { all: allRows.length }
    for (const r of allRows) c[r.type] = (c[r.type] ?? 0) + 1
    return c
  }, [allRows])

  // Change type is the first cut anyone makes on a pull, and its control lives
  // above the table, so it is applied before the table ever sees the rows.
  const rows = useMemo(
    () => (typeFilter === 'all' ? allRows : allRows.filter((r) => r.type === typeFilter)),
    [allRows, typeFilter],
  )

  const toggle = (key: string) => {
    setSel((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const allVisibleSelected = visible.length > 0 && visible.every((r) => sel.has(r.key))
  const setAllVisible = (on: boolean) => {
    setSel((s) => {
      const next = new Set(s)
      for (const r of visible) {
        if (on) next.add(r.key)
        else next.delete(r.key)
      }
      return next
    })
  }

  const columns = useMemo<ConceptColumn<Row>[]>(() => [
    // Nothing to tick when the changes are already decided (push side).
    ...(readOnly ? [] : [{
      id: '_select',
      header: '',
      headerCell: () => (
        <button type="button" className="flex w-full justify-center" onClick={() => setAllVisible(!allVisibleSelected)}>
          {allVisibleSelected ? <CheckSquare size={14} className="text-primary" /> : <Square size={14} className="text-muted-foreground" />}
        </button>
      ),
      accessor: () => '',
      cell: (r) => (
        <button type="button" className="flex w-full justify-center" onClick={() => toggle(r.key)}>
          {sel.has(r.key) ? <CheckSquare size={14} className="text-primary" /> : <Square size={14} className="text-muted-foreground" />}
        </button>
      ),
      filter: 'none',
      size: 36,
      minSize: 36,
    } as ConceptColumn<Row>]),
    {
      id: 'type',
      header: t('versioning.pull_col_change'),
      accessor: (r) => r.type,
      cell: (r) => (
        <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-bold uppercase', CHANGE_CLS[r.type])}>
          {t(`versioning.pull_change_${r.type}`)}
        </span>
      ),
      filter: 'select',
      selectOptionLabel: (v) => t(`versioning.pull_change_${v}`),
      size: 90,
      minSize: 60,
    },
    { id: 'sourceVocab', header: t('concept_mapping.col_source_vocabulary'), accessor: (r) => r.sourceVocab, filter: 'select', size: 100, minSize: 50 },
    { id: 'sourceCode', header: t('concept_mapping.col_source_concept_code'), accessor: (r) => r.sourceCode, filter: 'text', size: 110, minSize: 50 },
    { id: 'sourceName', header: t('concept_mapping.col_source_concept_name'), accessor: (r) => r.sourceName, filter: 'text', size: 220, minSize: 80 },
    { id: 'targetVocab', header: t('concept_mapping.col_target_vocabulary'), accessor: (r) => r.targetVocab, filter: 'select', size: 100, minSize: 50, hidden: true },
    { id: 'targetCode', header: t('concept_mapping.col_target_concept_code'), accessor: (r) => r.targetCode, filter: 'text', size: 110, minSize: 50 },
    { id: 'targetName', header: t('concept_mapping.col_target_concept_name'), accessor: (r) => r.targetName, filter: 'text', size: 220, minSize: 80 },
    { id: 'targetDomain', header: t('concept_mapping.col_domain'), accessor: (r) => r.targetDomain, filter: 'select', size: 110, minSize: 50, hidden: true },
    { id: 'targetStandard', header: t('concept_mapping.col_standard'), accessor: (r) => r.targetStandard, filter: 'select', size: 90, minSize: 50, hidden: true },
    { id: 'equivalence', header: t('concept_mapping.col_equivalence'), accessor: (r) => r.equivalence, filter: 'select', size: 150, minSize: 60, hidden: true },
    { id: 'status', header: t('concept_mapping.col_status'), accessor: (r) => r.status, filter: 'select', size: 100, minSize: 50, hidden: true },
    { id: 'comments', header: t('concept_mapping.comments'), accessor: (r) => r.comments, filter: 'text', tooltip: 'text-muted-foreground', size: 90, minSize: 50, hidden: true },
    { id: 'reviews', header: t('concept_mapping.col_reviews'), accessor: (r) => r.reviews, filter: 'text', tooltip: 'text-muted-foreground', size: 90, minSize: 50, hidden: true },
    { id: 'mappedBy', header: t('concept_mapping.col_mapped_by'), accessor: (r) => r.mappedBy, filter: 'text', tooltip: 'text-muted-foreground', size: 140, minSize: 60 },
    { id: 'mappedOn', header: t('concept_mapping.col_mapped_on'), accessor: (r) => r.mappedOn, filter: 'text', tooltip: 'text-muted-foreground', size: 170, minSize: 60, hidden: true },
    { id: 'reviewedBy', header: t('concept_mapping.col_reviewed_by'), accessor: (r) => r.reviewedBy, filter: 'text', tooltip: 'text-muted-foreground', size: 140, minSize: 60, hidden: true },
    { id: 'reviewedOn', header: t('concept_mapping.col_reviewed_on'), accessor: (r) => r.reviewedOn, filter: 'text', tooltip: 'text-muted-foreground', size: 170, minSize: 60, hidden: true },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, sel, allVisibleSelected, visible, readOnly])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] w-[97vw] max-w-[1500px] grid-cols-[minmax(0,1fr)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1500px]">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle>
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
                  onClick={() => pickType(tf)}
                  className={cn(
                    'rounded px-2 py-0.5 text-xs transition-colors',
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
          {!readOnly && (
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {t('versioning.pull_selected_count', { count: sel.size, total: changes.length })}
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <ConceptDataTable
            data={rows}
            columns={columns}
            rowKey={(r) => r.key}
            pageSize={PAGE_SIZE}
            viewKey={viewKey}
            onVisibleRowsChange={setVisible}
          />
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
