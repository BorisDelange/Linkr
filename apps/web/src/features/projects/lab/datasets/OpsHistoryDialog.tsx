import { useTranslation } from 'react-i18next'
import { Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetOp } from '@linkr/format'

interface Props {
  fileId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The dataset's edit history — every operation recorded against the immutable raw
 * file, oldest first. This IS the audit trail: the raw is never written to, so
 * this list plus the raw file fully determines what the dataset contains.
 */
export function OpsHistoryDialog({ fileId, open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const file = useDatasetStore((s) => s.files.find((f) => f.id === fileId))
  const compactFileOps = useDatasetStore((s) => s.compactFileOps)
  const ops = file?.ops ?? []
  const columnName = (id: string) => file?.columns?.find((c) => c.id === id)?.name ?? id

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="workbench"
      title={t('datasets.edit_history')}
      description={t('datasets.edit_history_description')}
      footerExtra={
        <Button
          variant="outline"
          size="sm"
          disabled={!ops.length}
          onClick={() => void compactFileOps(fileId)}
        >
          <Minimize2 className="mr-2 size-3.5" />
          {t('datasets.compact_history')}
        </Button>
      }
    >
      <ScrollArea className="h-full">
        {ops.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            {t('datasets.no_edits_yet')}
          </p>
        ) : (
          <ol className="space-y-1">
            {ops.map((op, i) => (
              <li
                key={op.id}
                className="flex items-baseline gap-2 rounded border px-2 py-1.5 text-xs"
              >
                <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <Badge variant="outline">{op.type}</Badge>
                <span className="min-w-0 flex-1 truncate">{describe(op, columnName, t)}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {new Date(op.at).toLocaleString()}
                </span>
              </li>
            ))}
          </ol>
        )}
      </ScrollArea>
    </DialogShell>
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
