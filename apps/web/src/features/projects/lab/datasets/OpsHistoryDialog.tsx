import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Minimize2, RotateCcw, Undo2 } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useDatasetStore } from '@/stores/dataset-store'
import { useUserDirectoryStore } from '@/stores/user-directory-store'
import type { DatasetOp, DatasetOpType } from '@linkr/format'

/** One row of the history table: an op plus what the view needs about it. */
interface OpRow {
  op: DatasetOp
  /** Position in the log — kept as rows are shown newest first. */
  position: number
  label: string
  author: string
}

/**
 * What each op did to the data, which is what the badge colours encode: green
 * adds, red removes, amber changes in place, and neutral for the ops that only
 * move things around.
 */
const OP_EFFECT: Record<DatasetOpType, 'add' | 'remove' | 'edit' | 'move'> = {
  addRow: 'add',
  addColumn: 'add',
  removeRow: 'remove',
  removeColumn: 'remove',
  setCell: 'edit',
  renameColumn: 'edit',
  reorderRows: 'move',
  reorderColumns: 'move',
}

const EFFECT_CLASS: Record<'add' | 'remove' | 'edit' | 'move', string> = {
  add: 'bg-green-500/15 text-green-700 dark:text-green-400 border-transparent',
  remove: 'bg-red-500/15 text-red-700 dark:text-red-400 border-transparent',
  edit: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-transparent',
  move: 'bg-muted text-muted-foreground border-transparent',
}

interface Props {
  fileId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The dataset's edit history — every operation recorded against the immutable raw
 * file. This IS the audit trail: the raw is never written to, so this list plus the
 * raw file fully determines what the dataset contains.
 *
 * Shown newest first: a long-running collection accumulates hundreds of entries,
 * and the ones worth checking are the ones just made.
 */
export function OpsHistoryDialog({ fileId, open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const file = useDatasetStore((s) => s.files.find((f) => f.id === fileId))
  const compactFileOps = useDatasetStore((s) => s.compactFileOps)
  const undoLastOps = useDatasetStore((s) => s.undoLastOps)
  const resetOps = useDatasetStore((s) => s.resetOps)
  const resolveName = useUserDirectoryStore((s) => s.resolveName)
  const [confirmingReset, setConfirmingReset] = useState(false)
  /**
   * Which action is running, not merely THAT one is.
   *
   * All three rewrite the log and make the server rebuild the Parquet cache from
   * it, which takes seconds on a large dataset. Naming the action lets its own
   * button carry the spinner, so the wait is attached to what was clicked rather
   * than to three buttons that merely went grey together.
   */
  const [busyAction, setBusyAction] = useState<'compact' | 'undo' | 'reset' | null>(null)
  const busy = busyAction !== null
  const ops = file?.ops ?? []
  const columnName = (id: string) => file?.columns?.find((c) => c.id === id)?.name ?? id

  const run = async (action: 'compact' | 'undo' | 'reset', fn: () => Promise<void>) => {
    setBusyAction(action)
    try { await fn() } finally { setBusyAction(null) }
  }

  const rows = useMemo<OpRow[]>(() => ops
    .map((op, i) => ({
      op,
      position: i + 1,
      label: describe(op, columnName, t),
      author: op.by == null ? '' : resolveName(Number(op.by)),
    }))
    .reverse(),
  // `columnName` closes over the file's columns, which `ops` changes alongside.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [ops, resolveName, t])

  const columns = useMemo<DataTableColumn<OpRow>[]>(() => [
    {
      id: 'position',
      header: t('datasets.op_position'),
      // Position in the LOG, not in the display: rows are shown newest first, and
      // numbering by display order would renumber every entry on each new edit.
      accessor: (r) => r.position,
      align: 'right',
      size: 70,
    },
    {
      id: 'type',
      header: t('common.type'),
      accessor: (r) => r.op.type,
      filter: 'select',
      size: 140,
      cell: (r) => (
        <Badge variant="outline" className={cn('font-normal', EFFECT_CLASS[OP_EFFECT[r.op.type]])}>
          {r.op.type}
        </Badge>
      ),
    },
    {
      id: 'label',
      header: t('common.description'),
      accessor: (r) => r.label,
      filter: 'text',
      size: 380,
    },
    {
      id: 'author',
      header: t('authoring.author'),
      // The log is shared, so an entry without an author is one recorded before
      // the field was stamped — shown as a dash rather than as nobody.
      accessor: (r) => r.author,
      display: (r) => r.author || '—',
      filter: 'select',
      size: 160,
    },
    {
      id: 'at',
      header: t('common.date'),
      // Sorts on the epoch, reads in the user's locale.
      accessor: (r) => r.op.at,
      display: (r) => new Date(r.op.at).toLocaleString(),
      size: 170,
    },
  ], [t])

  return (
    <>
      <DialogShell
        open={open}
        onOpenChange={onOpenChange}
        kind="workbench"
        title={t('datasets.edit_history')}
        description={t('datasets.edit_history_description')}
        hideFooter
        // The workbench body scrolls as one block; splitting it into a flex column
        // keeps the table scrolling under a footer that stays put.
        contentClassName="flex flex-col"
      >
        <div className="min-h-0 flex-1 overflow-auto">
          <DataTable
            data={rows}
            columns={columns}
            rowKey={(r) => r.op.id}
            pageSize={100}
            emptyMessage={t('datasets.no_edits_yet')}
          />
        </div>

        {/* Own footer rather than DialogShell's: this dialog has no Close button,
            since none of its actions is a "confirm" the user could back out of —
            each one takes effect as it is clicked. */}
        <div className="flex shrink-0 items-center gap-2 border-t pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={!ops.length || busy}
            onClick={() => void run('compact', () => compactFileOps(fileId))}
          >
            {busyAction === 'compact'
              ? <Loader2 className="mr-2 size-3.5 animate-spin" />
              : <Minimize2 className="mr-2 size-3.5" />}
            {t('datasets.compact_history')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={!ops.length || busy}
            onClick={() => void run('undo', () => undoLastOps(fileId))}
          >
            {busyAction === 'undo'
              ? <Loader2 className="mr-2 size-3.5 animate-spin" />
              : <Undo2 className="mr-2 size-3.5" />}
            {t('datasets.undo_last_edit')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={!ops.length || busy}
            onClick={() => setConfirmingReset(true)}
          >
            {busyAction === 'reset'
              ? <Loader2 className="mr-2 size-3.5 animate-spin" />
              : <RotateCcw className="mr-2 size-3.5" />}
            {t('datasets.reset_to_raw')}
          </Button>
        </div>
      </DialogShell>

      <AlertDialog open={confirmingReset} onOpenChange={setConfirmingReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('datasets.reset_to_raw')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('datasets.reset_to_raw_confirm', { count: ops.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void run('reset', () => resetOps(fileId))}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t('datasets.discard_all_changes')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** A one-line, human-readable account of what an op did. */
function describe(
  op: DatasetOp,
  columnName: (id: string) => string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  switch (op.type) {
    case 'setCell':
      return t('datasets.op_set_cell', {
        column: columnName(op.column),
        row: op.row,
        value: op.value === null ? '∅' : String(op.value),
      })
    case 'addRow':
      return t('datasets.op_add_row', { row: op.row })
    case 'removeRow':
      return t('datasets.op_remove_row', { row: op.row })
    case 'reorderRows':
      return t('datasets.op_reorder_rows', { count: op.order.length })
    case 'addColumn':
      return t('datasets.op_add_column', { column: op.name, type: op.colType })
    case 'removeColumn':
      return t('datasets.op_remove_column', { column: columnName(op.column) })
    case 'reorderColumns':
      return t('datasets.op_reorder_columns', { count: op.order.length })
    case 'renameColumn':
      return t('datasets.op_rename_column', { from: op.column, to: op.toName })
  }
}
