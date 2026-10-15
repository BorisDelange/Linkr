import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
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
import type { VisibilityState } from '@tanstack/react-table'
import { useConcepts, type ConceptRow } from '../../../concepts/use-concepts'
import { ConceptCountNotice } from '../../../concepts/ConceptCountNotice'
import { ConceptTable } from '../../../concepts/ConceptTable'
import { ConceptPickerToolbar } from '../../../concepts/ConceptPickerToolbar'
import { DEFAULT_HIDDEN_COLUMNS } from '../../../concepts/concept-queries'
import type { SchemaMapping } from '@/types'

interface CohortConceptPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedConceptIds: number[]
  onConfirm: (conceptIds: number[], conceptNames: Record<number, string>) => void
  dataSourceId: string | undefined
  schemaMapping: SchemaMapping | undefined
}

export function CohortConceptPickerDialog({
  open,
  onOpenChange,
  selectedConceptIds,
  onConfirm,
  dataSourceId,
  schemaMapping,
}: CohortConceptPickerDialogProps) {
  const { t } = useTranslation()

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [selectedNames, setSelectedNames] = useState<Map<number, string>>(new Map())

  const hook = useConcepts(open ? dataSourceId : undefined, open ? schemaMapping : undefined, 'picker')

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    () => Object.fromEntries(DEFAULT_HIDDEN_COLUMNS.map((id) => [id, false])),
  )

  // Synced on opening only: the caller passes a fresh array on every render.
  useEffect(() => {
    if (open) setSelectedIds(new Set(selectedConceptIds))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Names of the rows seen, so the selected panel can label concepts picked on
  // another page.
  useEffect(() => {
    if (!hook.concepts.length) return
    setSelectedNames((prev) => {
      if (hook.concepts.every((c) => prev.has(c.concept_id))) return prev
      const next = new Map(prev)
      for (const c of hook.concepts) {
        if (!next.has(c.concept_id)) next.set(c.concept_id, c.concept_name)
      }
      return next
    })
  }, [hook.concepts])

  const rememberName = useCallback((row: ConceptRow) => {
    setSelectedNames((prev) => {
      if (prev.get(row.concept_id) === row.concept_name) return prev
      const next = new Map(prev)
      next.set(row.concept_id, row.concept_name)
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

  const clearAll = useCallback(() => setSelectedIds(new Set()), [])

  const handleConfirm = () => {
    const names: Record<number, string> = {}
    for (const id of selectedIds) {
      names[id] = selectedNames.get(id) ?? `#${id}`
    }
    onConfirm([...selectedIds], names)
  }

  const selectedList = useMemo(
    () => [...selectedIds].map((id) => ({ id, name: selectedNames.get(id) ?? `#${id}` })),
    [selectedIds, selectedNames],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] max-w-[95vw] sm:max-w-[95vw] flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle>{t('cohorts.concept_pick')}</DialogTitle>
        </DialogHeader>
        <ConceptCountNotice count={hook.count} dataSourceId={dataSourceId} className="mx-4 mt-3" />

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-r">
            <ConceptPickerToolbar
              availableColumns={hook.availableColumns}
              filters={hook.filters}
              filterOptions={hook.filterOptions}
              onFilterChange={hook.updateFilter}
            />
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
                selectedConceptIds={selectedIds}
                onSelectedConceptIdsChange={setSelectedIds}
                onPageChange={hook.setPage}
                onPageSizeChange={(size) => {
                  hook.setPageSize(size)
                  hook.setPage(0)
                }}
                pickMode
                onToggleConcept={rememberName}
                emptyMessage={t('patient_data.no_concepts_found')}
              />
            </div>
          </div>

          <div className="flex w-64 shrink-0 flex-col">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-xs font-medium">
                {t('cohorts.concept_selected')}
              </span>
              <Badge variant="secondary">
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
                <ScrollArea className="min-h-0 flex-1">
                  <div className="p-1.5">
                    {selectedList.map((item) => (
                      <div
                        key={item.id}
                        className="group flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-accent/50"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs">
                          {item.name}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                          {item.id}
                        </span>
                        <button
                          type="button"
                          className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                          onClick={() => removeConcept(item.id)}
                          aria-label={t('patient_data.remove')}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
                <div className="border-t px-3 py-2">
                  <Button
                    variant="ghost"
                    size="sm-tight"
                    className="w-full text-muted-foreground"
                    onClick={clearAll}
                  >
                    {t('patient_data.clear_selection')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>

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
