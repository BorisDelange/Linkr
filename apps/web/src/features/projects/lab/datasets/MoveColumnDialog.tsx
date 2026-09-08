import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FormField } from '@/components/ui/form-field'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetColumn } from '@/types'
import { TypeBadge } from './TypeBadge'

interface Props {
  fileId: string
  column: DatasetColumn
  open: boolean
  onOpenChange: (open: boolean) => void
}

const START = '__start__'

/**
 * Move a column to an arbitrary position, for the jump that stepping left and
 * right one slot at a time cannot reasonably make.
 *
 * Position is expressed as "after which column", the same vocabulary the add-column
 * dialog uses, rather than an index — a number would have to be explained (is it
 * 0-based? before or after the move?) where a column name never does.
 */
export function MoveColumnDialog({ fileId, column, open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const applyOps = useDatasetStore((s) => s.applyOps)
  const file = useDatasetStore((s) => s.files.find((f) => f.id === fileId))
  const [after, setAfter] = useState(START)
  const [busy, setBusy] = useState(false)

  const columns = file?.columns ?? []
  // A column cannot land after itself, so it is not an option.
  const targets = columns.filter((c) => c.id !== column.id)

  const submit = async () => {
    setBusy(true)
    try {
      const rest = columns.filter((c) => c.id !== column.id).map((c) => c.id)
      const at = after === START ? 0 : rest.indexOf(after) + 1
      rest.splice(at, 0, column.id)
      await applyOps(fileId, [{
        id: crypto.randomUUID(), at: Date.now(), group: crypto.randomUUID(),
        type: 'reorderColumns', order: rest,
      }])
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t('datasets.col_move_to')}
      description={t('datasets.col_move_to_description', { name: column.label ?? column.name })}
      onConfirm={submit}
      confirmLabel={t('common.move')}
      busy={busy}
    >
      <FormField label={t('datasets.column_position')}>
        {({ id }) => (
          <Select value={after} onValueChange={setAfter}>
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={START}>{t('datasets.position_start')}</SelectItem>
              {targets.map((col) => (
                <SelectItem key={col.id} value={col.id}>
                  <span className="flex items-center gap-2">
                    <TypeBadge type={col.type} size="sm" />
                    {t('datasets.position_after', { name: col.label ?? col.name })}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
    </DialogShell>
  )
}
