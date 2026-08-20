import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckSquare, Square } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
import { cn } from '@/lib/utils'
import type { SourceConceptChange, SourceConceptsDiff } from '@/lib/api/git'

interface PullConceptsDialogProps {
  diff: SourceConceptsDiff | undefined
  /** The rows that moved, when the server could key both sides. */
  changes: SourceConceptChange[]
  /** Keys previously refused, so reopening restores the choice. */
  declined: ReadonlySet<string>
  onClose: () => void
  /** Confirm: `declined` is every row left unticked. */
  onApply: (declined: Set<string>) => void
}

const STATE_CLS: Record<SourceConceptChange['state'], string> = {
  add: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  delete: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
  modify: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
}

/**
 * Pick which source-concept changes to take — the twin of `PullMappingsTable`.
 *
 * Same interaction model on purpose (checkbox column, sortable headers, per-column
 * filters): two tables doing the same job should not be driven differently. The
 * source list is still written as one CSV, but the applier rebuilds that file
 * around the refusals (`mergeSourceConceptsCsv`), so ticking rows here is a real
 * choice and not a decoration.
 */
export function PullConceptsDialog({ diff, changes, declined, onClose, onApply }: PullConceptsDialogProps) {
  const { t } = useTranslation()
  // Everything taken until the user says otherwise — pulling is why they are here.
  const [sel, setSel] = useState<Set<string>>(
    () => new Set(changes.filter((c) => !declined.has(c.key)).map((c) => c.key)),
  )
  // The rows left by the table's own filters: select-all must act on what is shown.
  const [visible, setVisible] = useState<SourceConceptChange[]>(changes)

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

  const columns = useMemo<ConceptColumn<SourceConceptChange>[]>(() => [
    {
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
    },
    {
      id: 'state',
      header: t('versioning.pull_col_change'),
      accessor: (r) => r.state,
      cell: (r) => (
        <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-bold uppercase', STATE_CLS[r.state])}>
          {t(`versioning.pull_change_${r.state === 'modify' ? 'update' : r.state}`)}
        </span>
      ),
      filter: 'select',
      size: 90,
      minSize: 60,
    },
    {
      id: 'vocabulary',
      header: t('concept_mapping.col_source_vocabulary'),
      accessor: (r) => r.vocabulary,
      filter: 'select',
      size: 160,
      minSize: 60,
    },
    {
      id: 'code',
      header: t('concept_mapping.col_source_concept_code'),
      accessor: (r) => r.code,
      filter: 'text',
      size: 140,
      minSize: 60,
    },
    {
      id: 'name',
      header: t('concept_mapping.col_source_concept_name'),
      accessor: (r) => r.name,
      filter: 'text',
      size: 320,
      minSize: 100,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, sel, allVisibleSelected, visible])

  // Nothing to list: the server couldn't key a side, so the file is all-or-nothing.
  if (changes.length === 0) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('versioning.pull_concepts_title')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-2 py-6 text-center text-muted-foreground">
            <AlertTriangle size={26} />
            <p className="text-sm">{t('versioning.pull_diff_whole_file')}</p>
            {diff && (
              <p className="text-xs">
                {t('versioning.pull_concepts_totals', { local: diff.localTotal, remote: diff.remoteTotal })}
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="outline" size="sm" onClick={() => onApply(new Set(['*']))}>{t('versioning.pull_keep_mine')}</Button>
            <Button size="sm" onClick={() => onApply(new Set())}>{t('versioning.pull_take')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] w-[97vw] max-w-[1500px] grid-cols-[minmax(0,1fr)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1500px]">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle>{t('versioning.pull_concepts_title')}</DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <span className="text-xs text-muted-foreground">
            {t('versioning.pull_selected_count', { count: sel.size, total: changes.length })}
          </span>
          {diff?.changesTruncated && (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {t('versioning.pull_concepts_truncated')}
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <ConceptDataTable
            data={changes}
            columns={columns}
            rowKey={(r) => r.key}
            onVisibleRowsChange={setVisible}
          />
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" onClick={() => onApply(new Set(changes.filter((c) => !sel.has(c.key)).map((c) => c.key)))}>
            {t('common.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
