import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { columnId as deriveColumnId } from '@/lib/column-id'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetColumn } from '@/types'
import { TypeBadge } from './TypeBadge'
import { announceAdded } from './use-flash-target'

interface Props {
  fileId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const TYPES: DatasetColumn['type'][] = ['string', 'number', 'boolean', 'date']

const START = '__start__'
const END = '__end__'

/** Add a column to a dataset. Recorded as an op, so it is undoable and travels
 *  with the dataset — the raw file is untouched. */
export function AddColumnDialog({ fileId, open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const applyOps = useDatasetStore((s) => s.applyOps)
  const file = useDatasetStore((s) => s.files.find((f) => f.id === fileId))
  const [name, setName] = useState('')
  const [type, setType] = useState<DatasetColumn['type']>('string')
  // Where the column lands: the id of the column to sit after, or END.
  const [after, setAfter] = useState<string>(END)
  const [busy, setBusy] = useState(false)

  const trimmed = name.trim()
  // The id is derived from the name, so a duplicate name is a duplicate id.
  const taken = (file?.columns ?? []).some((c) => c.id === deriveColumnId(trimmed))

  const submit = async () => {
    if (!trimmed || taken) return
    setBusy(true)
    try {
      const columns = file?.columns ?? []
      // `index` is the slot the column takes; omitted means append.
      const index = after === END ? undefined
        : after === START ? 0
        : columns.findIndex((c) => c.id === after) + 1
      const column = deriveColumnId(trimmed)
      await applyOps(fileId, [{
        id: crypto.randomUUID(), at: Date.now(), group: crypto.randomUUID(),
        type: 'addColumn', column, name: trimmed, colType: type, index,
      }])
      announceAdded({ fileId, column })
      setName('')
      setType('string')
      setAfter(END)
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t('datasets.add_column')}
      description={t('datasets.add_column_description')}
      onConfirm={submit}
      confirmLabel={t('common.add')}
      confirmDisabled={!trimmed || taken}
      busy={busy}
    >
      <FormField label={t('common.name')} required>
        {({ id }) => (
          <>
            <Input
              id={id}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('datasets.column_name_placeholder')}
            />
            {taken && (
              <p className="text-xs text-destructive">{t('datasets.column_name_taken')}</p>
            )}
          </>
        )}
      </FormField>

      <FormField label={t('datasets.column_position')}>
        {({ id }) => (
          <Select value={after} onValueChange={setAfter}>
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={START}>{t('datasets.position_start')}</SelectItem>
              <SelectItem value={END}>{t('datasets.position_end')}</SelectItem>
              {(file?.columns ?? []).map((col) => (
                <SelectItem key={col.id} value={col.id}>
                  {t('datasets.position_after', { name: col.label ?? col.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>

      <FormField label={t('datasets.column_type')}>
        {({ id }) => (
          <Select value={type} onValueChange={(v) => setType(v as DatasetColumn['type'])}>
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((ty) => (
                <SelectItem key={ty} value={ty}>
                  <span className="flex items-center gap-2">
                    <TypeBadge type={ty} size="sm" />
                    {t(`datasets.type_${ty}`)}
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
