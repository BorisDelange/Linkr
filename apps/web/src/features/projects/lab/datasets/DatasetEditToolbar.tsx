import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Check, History, Pencil, Plus, RotateCcw, Trash2, Undo2 } from 'lucide-react'
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
import { announceAdded } from './use-flash-target'

interface DatasetEditToolbarProps {
  fileId: string
  editing: boolean
  onEditingChange: (editing: boolean) => void
  /** Row ordinal of the selected cell, when one is selected. */
  selectedRow?: number
  /** The ordinal displayed just before the given one, for "insert above". */
  rowBefore?: (ordinal: number) => number | null
}

/**
 * Edit controls for the dataset table: the edit-mode toggle, row/column
 * operations, undo, and the history of recorded operations.
 *
 * Every action records an op — the raw file is never written to, so any of this is
 * reversible and the whole sequence is auditable.
 */
export function DatasetEditToolbar({
  fileId, editing, onEditingChange, selectedRow, rowBefore,
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

  /** `where` decides the insert point: at the end, or around the selected row. */
  const addRow = async (where: 'end' | 'above' | 'below') => {
    // A new row takes the next free negative ordinal: raw ordinals are the file's
    // own positions, so negative space can never collide with them.
    const lowest = Math.min(0, ...ops.filter((o) => o.type === 'addRow').map((o) => o.row))
    const row = lowest - 1

    // `after` names the row to land behind, so inserting ABOVE the selection means
    // landing after the one before it — which at the top of the table is "no row".
    let after: number | null = null
    if (where !== 'end' && selectedRow !== undefined) {
      after = where === 'below' ? selectedRow : (rowBefore?.(selectedRow) ?? null)
    }

    await applyOps(fileId, [{
      id: crypto.randomUUID(), at: Date.now(), group: crypto.randomUUID(),
      type: 'addRow', row, after,
    }])
    announceAdded({ fileId, row })
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs">
                  <Plus className="size-3.5" />
                  <span className="ml-1">{t('datasets.add_row')}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  disabled={selectedRow === undefined}
                  onSelect={() => void addRow('above')}
                >
                  <ArrowUp className="mr-2 size-3.5" />
                  {t('datasets.insert_above')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={selectedRow === undefined}
                  onSelect={() => void addRow('below')}
                >
                  <ArrowDown className="mr-2 size-3.5" />
                  {t('datasets.insert_below')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void addRow('end')}>
                  <Plus className="mr-2 size-3.5" />
                  {t('datasets.insert_at_end')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

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
