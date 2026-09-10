import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Check, Search, X } from 'lucide-react'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fuzzyTextMatch } from '@/lib/fuzzy-search'
import {
  datasetSeriesKeyId,
  datasetSeriesOptions,
  type DatasetTimelineMapping,
} from '@/lib/patient-data/dataset-timeline'
import { ConceptColorSwatch } from './ConceptColorSwatch'
import { ConceptTable } from '../concepts/ConceptTable'
import type { ConceptRow } from '../concepts/use-concepts'
import type { ColumnDescriptor } from '../concepts/concept-queries'
import type { VisibilityState } from '@tanstack/react-table'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The dataset's rows, already fetched by the field that opens this. */
  rows: readonly Record<string, unknown>[]
  mapping: DatasetTimelineMapping
  /** Per-series colours, keyed by the synthetic concept id, shared with the concepts. */
  colors: Record<string, string>
  onConfirm: (codes: string[], colors: Record<string, string>) => void
}

/**
 * The columns the series table shows.
 *
 * Deliberately the shape `ConceptTable` already speaks: a dataset series answers
 * the same three questions a concept does — what is it, how many rows, how many
 * patients — so it reuses the Concepts page's table wholesale rather than growing a
 * second one that would drift from it.
 */
const COLUMNS: ColumnDescriptor[] = [
  { id: 'concept_name', source: 'core', filterable: false },
  { id: 'concept_code', source: 'code', filterable: false },
  { id: 'record_count', source: 'computed', filterable: false },
  { id: 'patient_count', source: 'computed', filterable: false },
]

const HIDDEN: VisibilityState = { concept_id: false }

const PAGE_SIZE = 50

export function DatasetSeriesPickerDialog({
  open, onOpenChange, rows, mapping, colors, onConfirm,
}: Props) {
  const { t } = useTranslation()

  // Pick ORDER is the contract, exactly as it is for concepts: it drives the auto
  // colour, so this is an array and not a Set.
  const [selected, setSelected] = useState<string[]>([])
  const [draftColors, setDraftColors] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  useEffect(() => {
    if (!open) return
    setSelected([...(mapping.codes ?? [])])
    setDraftColors({ ...colors })
    setSearch('')
    setPage(0)
    // Re-seeding on every `colors` identity change would wipe edits mid-dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Counted over the WHOLE dataset, not the selected patient: the point is to
  // choose what is worth plotting at all, which a single patient's rows cannot say.
  const options = useMemo(
    () => (open ? datasetSeriesOptions(rows, mapping) : []),
    [open, rows, mapping],
  )

  const idOf = useCallback(
    (code: string) => datasetSeriesKeyId(mapping.datasetFileId, code),
    [mapping.datasetFileId],
  )

  const nameByCode = useMemo(() => {
    const out = new Map<string, string>()
    for (const o of options) out.set(o.code, o.name)
    return out
  }, [options])

  const filtered = useMemo(() => {
    const q = search.trim()
    if (!q) return options
    return options.filter((o) => fuzzyTextMatch(o.name, q) || fuzzyTextMatch(o.code, q))
  }, [options, search])

  // `ConceptTable` pages its own rows, so hand it the page rather than the lot:
  // a dataset with thousands of distinct codes would otherwise render them all.
  const pageRows: ConceptRow[] = useMemo(
    () => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((o) => ({
      concept_id: idOf(o.code),
      concept_name: o.name,
      concept_code: o.code,
      record_count: o.recordCount,
      patient_count: o.patientCount,
    })),
    [filtered, page, idOf],
  )

  const selectedIdSet = useMemo(
    () => new Set(selected.map(idOf)),
    [selected, idOf],
  )

  /** The table speaks synthetic ids; the config stores codes. Fold back by id. */
  const applySelection = useCallback((next: Set<number>) => {
    setSelected((prev) => {
      const kept = prev.filter((code) => next.has(idOf(code)))
      const known = new Set(kept.map(idOf))
      const added = options
        .filter((o) => next.has(idOf(o.code)) && !known.has(idOf(o.code)))
        .map((o) => o.code)
      return [...kept, ...added]
    })
  }, [options, idOf])

  const setColor = useCallback((code: string, color: string | undefined) => {
    setDraftColors((prev) => {
      const next = { ...prev }
      if (color) next[String(idOf(code))] = color
      else delete next[String(idOf(code))]
      return next
    })
  }, [idOf])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] max-w-[95vw] flex-col gap-0 p-0 sm:max-w-[95vw]">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle>{t('patient_data.dataset_pick_series')}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <Allotment proportionalLayout={false}>
            <Allotment.Pane minSize={360}>
              <div className="flex h-full min-w-0 flex-col overflow-hidden border-r">
                <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
                  <div className="relative min-w-0 flex-1">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-8 pl-8 pr-7 text-xs"
                      value={search}
                      onChange={(e) => { setSearch(e.target.value); setPage(0) }}
                      placeholder={t('patient_data.dataset_search_series')}
                    />
                    {search && (
                      <button
                        type="button"
                        onClick={() => { setSearch(''); setPage(0) }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={t('common.clear')}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t('patient_data.dataset_series_count', { count: filtered.length })}
                  </span>
                </div>

                <div className="min-h-0 flex-1">
                  <ConceptTable
                    concepts={pageRows}
                    totalCount={filtered.length}
                    page={page}
                    pageSize={PAGE_SIZE}
                    totalPages={totalPages}
                    isLoading={false}
                    selectedConceptId={null}
                    availableColumns={COLUMNS}
                    filters={{}}
                    filterOptions={{}}
                    sorting={null}
                    columnVisibility={HIDDEN}
                    onColumnVisibilityChange={() => {}}
                    onFilterChange={() => {}}
                    onSortingChange={() => {}}
                    onSelect={() => {}}
                    selectedConceptIds={selectedIdSet}
                    onSelectedConceptIdsChange={applySelection}
                    onPageChange={setPage}
                    onPageSizeChange={() => {}}
                    pickMode
                    emptyMessage={t('patient_data.dataset_no_series')}
                  />
                </div>
              </div>
            </Allotment.Pane>

            <Allotment.Pane minSize={200} preferredSize={300} maxSize={420}>
              <div className="flex h-full min-w-0 flex-col">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <span className="text-xs font-medium">{t('patient_data.dataset_selected_series')}</span>
                  <Badge variant="secondary">{selected.length}</Badge>
                </div>
                {selected.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center p-4">
                    <p className="text-center text-xs text-muted-foreground">
                      {t('patient_data.dataset_no_series_selected')}
                    </p>
                  </div>
                ) : (
                  <>
                    <ScrollArea className="min-h-0 flex-1 [&>div>div]:!block [&>div>div]:!min-w-0">
                      <div className="p-1.5">
                        {selected.map((code, index) => (
                          <div
                            key={code}
                            className="group flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-accent/50"
                          >
                            <button
                              type="button"
                              className="flex size-4 shrink-0 items-center justify-center rounded border border-primary bg-primary text-primary-foreground"
                              onClick={() => setSelected((prev) => prev.filter((c) => c !== code))}
                              title={t('patient_data.remove')}
                            >
                              <Check size={10} />
                            </button>
                            <ConceptColorSwatch
                              value={draftColors[String(idOf(code))]}
                              index={index}
                              onChange={(color) => setColor(code, color)}
                            />
                            <span className="min-w-0 flex-1 truncate text-xs">
                              {nameByCode.get(code) ?? code}
                            </span>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                    <div className="border-t px-3 py-2">
                      <Button
                        variant="ghost"
                        size="sm-tight"
                        className="w-full text-muted-foreground"
                        onClick={() => setSelected([])}
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

        <DialogFooter className="shrink-0 border-t px-6 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => { onConfirm([...selected], draftColors); onOpenChange(false) }}
          >
            {t('common.confirm')} ({selected.length})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
