import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { columnId as deriveColumnId } from '@linkr/format'
import { TypeBadge } from '@/features/projects/lab/datasets/TypeBadge'
import type { DatasetColumn } from '@/types'

/** Types a collected variable can take. `unknown` is what the parser falls back to,
 *  never something to choose on purpose. */
const VARIABLE_TYPES: DatasetColumn['type'][] = ['string', 'number', 'boolean', 'date']

export interface VariableDraft {
  /** Derived from the name, never typed — see the dialog's own doc comment. */
  id: string
  name: string
  type: DatasetColumn['type']
  label?: string
  description?: string
  required?: boolean
  withTime?: boolean
  allowedValues?: string[]
  min?: number | string
  max?: number | string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The variable being edited; absent when adding a new one. */
  column?: DatasetColumn
  /** Ids already taken, so a new variable cannot collide with one. */
  takenIds: string[]
  onSubmit: (draft: VariableDraft) => void | Promise<void>
}

/**
 * One dialog for both adding and editing a collected variable.
 *
 * Same fields either way: adding a variable and editing one ask the same questions,
 * and splitting them across an inline row (add) and a dialog (edit) meant the
 * options you could set depended on when you set them — a variable created inline
 * could not be given a description until after it existed.
 *
 * Three names, only two of them typed — the same split the Datasets page uses:
 * **name** is the column as it appears in the CSV, **label** is what the collector
 * reads on screen, and the technical **id** is derived from the name (`col_<slug>`)
 * and only shown. Offering the id as a third input made the dialog ask the same
 * question twice; and once the column exists the id is frozen anyway, since changing
 * it is a REKEY that has to repair dashboard filters and widget configs — that path
 * lives in the datasets page's rename.
 */
export function VariableDialog({ open, onOpenChange, column, takenIds, onSubmit }: Props) {
  const { t } = useTranslation()
  const editing = column != null

  const [name, setName] = useState('')
  const [type, setType] = useState<DatasetColumn['type']>('string')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [required, setRequired] = useState(false)
  const [withTime, setWithTime] = useState(false)
  const [allowed, setAllowed] = useState('')
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [busy, setBusy] = useState(false)

  // Re-seeded on open so the dialog never shows the previous variable's values, and
  // so closing it discards whatever was typed.
  useEffect(() => {
    if (!open) return
    setName(column?.name ?? '')
    setType(column?.type ?? 'string')
    setLabel(column?.label ?? '')
    setDescription(column?.description ?? '')
    setRequired(column?.required ?? false)
    setWithTime(column?.withTime ?? false)
    setAllowed((column?.allowedValues ?? []).join('\n'))
    setMin(column?.min == null ? '' : String(column.min))
    setMax(column?.max == null ? '' : String(column.max))
  }, [open, column])

  // Derived from the name, the same way column ids are derived everywhere else.
  const effectiveId = editing ? column.id : deriveColumnId(name)
  const collides = !editing && effectiveId !== '' && takenIds.includes(effectiveId)
  const valid = name.trim() !== '' && effectiveId !== '' && !collides

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    try {
      await onSubmit({
        id: effectiveId,
        name: name.trim(),
        type,
        label: label.trim() || undefined,
        description: description.trim() || undefined,
        required: required || undefined,
        withTime: (type === 'date' && withTime) || undefined,
        allowedValues: allowed.split('\n').map((v) => v.trim()).filter(Boolean),
        min: min === '' ? undefined : type === 'number' ? Number(min) : min,
        max: max === '' ? undefined : type === 'number' ? Number(max) : max,
      })
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  const bounded = type === 'number' || type === 'date'

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={editing ? t('patient_data.collection_edit_variable') : t('patient_data.collection_add_variable')}
      onConfirm={() => void submit()}
      confirmLabel={editing ? t('common.save') : t('common.add')}
      confirmDisabled={!valid}
      busy={busy}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <FormField label={t('common.name')} hint={t('datasets.col_name_hint')} hintInTooltip required>
            {({ id: fid }) => (
              <Input
                id={fid}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            )}
          </FormField>
          <FormField label={t('datasets.type')}>
            {({ id: fid }) => (
              <Select value={type} onValueChange={(v) => setType(v as DatasetColumn['type'])}>
                <SelectTrigger id={fid}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VARIABLE_TYPES.map((ty) => (
                    <SelectItem key={ty} value={ty}>
                      <span className="flex items-center gap-2">
                        <TypeBadge type={ty} size="sm" noTooltip />
                        {t(`datasets.type_${ty}`)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
        </div>

        {/* Shown, not editable: the id is what widgets and queries reference, so it
            is worth seeing, but typing it is a second answer to the same question. */}
        {effectiveId && (
          <p className="-mt-2 text-[10px] text-muted-foreground">
            {t('datasets.col_id')}: <code className="font-mono">{effectiveId}</code>
          </p>
        )}
        {collides && (
          <p className="text-xs text-destructive">{t('datasets.col_id_taken')}</p>
        )}

        <FormField label={t('datasets.col_meta_label')} hint={t('datasets.col_meta_label_hint')} hintInTooltip>
          {({ id: fid }) => (
            <Input
              id={fid}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={name}
            />
          )}
        </FormField>

        <FormField label={t('datasets.col_meta_description')}>
          {({ id: fid }) => (
            <Textarea
              id={fid}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          )}
        </FormField>

        {bounded && (
          <div className="grid grid-cols-2 gap-3">
            <FormField label={t('datasets.col_min')}>
              {({ id: fid }) => (
                <Input
                  id={fid}
                  type={type === 'number' ? 'number' : 'date'}
                  value={min}
                  onChange={(e) => setMin(e.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('datasets.col_max')}>
              {({ id: fid }) => (
                <Input
                  id={fid}
                  type={type === 'number' ? 'number' : 'date'}
                  value={max}
                  onChange={(e) => setMax(e.target.value)}
                />
              )}
            </FormField>
          </div>
        )}

        {type === 'string' && (
          <FormField
            label={t('datasets.col_allowed_values')}
            hint={t('datasets.col_allowed_values_hint')}
            hintInTooltip
          >
            {({ id: fid }) => (
              <Textarea
                id={fid}
                value={allowed}
                onChange={(e) => setAllowed(e.target.value)}
                rows={3}
              />
            )}
          </FormField>
        )}

        <div className="flex flex-col gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox checked={required} onCheckedChange={(v) => setRequired(v === true)} />
            {t('datasets.col_required')}
          </label>
          {type === 'date' && (
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox checked={withTime} onCheckedChange={(v) => setWithTime(v === true)} />
              {t('datasets.col_with_time')}
            </label>
          )}
        </div>
      </div>
    </DialogShell>
  )
}
