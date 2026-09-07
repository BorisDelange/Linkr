import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, History, Pencil, Plus, RotateCcw, Trash2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetOp } from '@linkr/format'
import { AddColumnDialog } from './AddColumnDialog'
import { OpsHistoryDialog } from './OpsHistoryDialog'

interface DatasetEditToolbarProps {
  fileId: string
  editing: boolean
  onEditingChange: (editing: boolean) => void
  /** Row ordinal of the selected cell, when one is selected. */
  selectedRow?: number
}

/**
 * Edit controls for the dataset table: the edit-mode toggle, row/column
 * operations, undo, and the history of recorded operations.
 *
 * Every action records an op — the raw file is never written to, so any of this is
 * reversible and the whole sequence is auditable.
 */
export function DatasetEditToolbar({
  fileId, editing, onEditingChange, selectedRow,
}: DatasetEditToolbarProps) {
  const { t } = useTranslation()
  const applyOps = useDatasetStore((s) => s.applyOps)
  const undoLastOps = useDatasetStore((s) => s.undoLastOps)
  const resetOps = useDatasetStore((s) => s.resetOps)
  const file = useDatasetStore((s) => s.files.find((f) => f.id === fileId))
  const [addingColumn, setAddingColumn] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  const ops = file?.ops ?? []
  const hasOps = ops.length > 0

  const addRow = () => {
    // A new row takes the next free negative ordinal: raw ordinals are the file's
    // own positions, so negative space can never collide with them.
    const lowest = Math.min(0, ...ops.filter((o) => o.type === 'addRow').map((o) => o.row))
    void applyOps(fileId, [{
      id: crypto.randomUUID(), at: Date.now(), group: crypto.randomUUID(),
      type: 'addRow', row: lowest - 1, after: selectedRow ?? null,
    }])
  }

  const removeRow = () => {
    if (selectedRow === undefined) return
    void applyOps(fileId, [{
      id: crypto.randomUUID(), at: Date.now(), group: crypto.randomUUID(),
      type: 'removeRow', row: selectedRow,
    } as DatasetOp])
  }

  return (
    <TooltipProvider>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={editing ? 'default' : 'ghost'}
              size="xs"
              onClick={() => onEditingChange(!editing)}
            >
              {editing ? <Check className="size-3.5" /> : <Pencil className="size-3.5" />}
              <span className="ml-1">{editing ? t('datasets.editing') : t('datasets.edit_data')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('datasets.edit_data_hint')}</TooltipContent>
        </Tooltip>

        {editing && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="xs" onClick={addRow}>
                  <Plus className="size-3.5" />
                  <span className="ml-1">{t('datasets.add_row')}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('datasets.add_row_hint')}</TooltipContent>
            </Tooltip>

            <Button variant="ghost" size="xs" onClick={() => setAddingColumn(true)}>
              <Plus className="size-3.5" />
              <span className="ml-1">{t('datasets.add_column')}</span>
            </Button>

            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={selectedRow === undefined}
                    onClick={removeRow}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('datasets.remove_row')}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!hasOps}
                    onClick={() => void undoLastOps(fileId)}
                  >
                    <Undo2 className="size-3.5" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('datasets.undo_edit')}</TooltipContent>
            </Tooltip>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" disabled={!hasOps}>
                  <History className="size-3.5" />
                  <span className="ml-1 tabular-nums">{ops.length}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{t('datasets.edit_history')}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                  <History className="mr-2 size-3.5" />
                  {t('datasets.view_history')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => void resetOps(fileId)}
                >
                  <RotateCcw className="mr-2 size-3.5" />
                  {t('datasets.reset_to_raw')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        <AddColumnDialog
          fileId={fileId}
          open={addingColumn}
          onOpenChange={setAddingColumn}
        />
        <OpsHistoryDialog
          fileId={fileId}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
        />
      </div>
    </TooltipProvider>
  )
}
