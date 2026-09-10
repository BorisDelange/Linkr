import { useEffect, useMemo, useState } from 'react'
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
import { fitsColumnType } from '@/lib/dataset-utils'
import {
  cleanLocalized, localizedRaw, seedLocalizedForEditing, setLocalized,
} from '@/lib/localized'
import { TypeBadge } from '@/features/projects/lab/datasets/TypeBadge'
import type { DatasetColumn, LocalizedString } from '@/types'

/** Types a collected variable can take. `unknown` is what the parser falls back to,
 *  never something to choose on purpose. */
const VARIABLE_TYPES: DatasetColumn['type'][] = ['string', 'number', 'boolean', 'date']

export interface VariableDraft {
  /** Derived from the name, never typed — see the dialog's own doc comment. */
  id: string
  name: string
  type: DatasetColumn['type']
  label?: LocalizedString
  description?: LocalizedString
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
  /** Values already collected in this column, to warn before a lossy retype. */
  values?: unknown[]
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
export function VariableDialog({
  open, onOpenChange, column, takenIds, values, onSubmit,
}: Props) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const editing = column != null

  const [name, setName] = useState('')
  const [type, setType] = useState<DatasetColumn['type']>('string')
  // Multilingual, edited one language at a time — the active UI language, as in the
  // Datasets page's own column dialog and everywhere else in the app.
  const [label, setLabel] = useState<LocalizedString>({})
  const [description, setDescription] = useState<LocalizedString>({})
  const [required, setRequired] = useState(false)
  const [withTime, setWithTime] = useState(false)
  const [allowed, setAllowed] = useState('')
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  // Re-seeded on open so the dialog never shows the previous variable's values, and
  // so closing it discards whatever was typed.
  useEffect(() => {
    if (!open) return
    setName(column?.name ?? '')
    setType(column?.type ?? 'string')
    setLabel(seedLocalizedForEditing(column?.label, language))
    setDescription(seedLocalizedForEditing(column?.description, language))
    setRequired(column?.required ?? false)
    setWithTime(column?.withTime ?? false)
    setAllowed((column?.allowedValues ?? []).join('\n'))
    setMin(column?.min == null ? '' : String(column.min))
    setMax(column?.max == null ? '' : String(column.max))
    setSubmitted(false)
  }, [open, column, language])

  // Derived from the name, the same way column ids are derived everywhere else.
  const effectiveId = editing ? column.id : deriveColumnId(name)
  // Never once submitted: saving adds the name to `takenIds` and clears the edited
  // column, so between the save and the unmount the guard would flash "name already
  // taken" at the very name it just saved. `submitted` latches until the dialog is
  // re-opened, which `busy` alone cannot do — it is cleared before the close lands.
  const collides = !editing && !submitted && effectiveId !== ''
    && takenIds.includes(effectiveId)
  const valid = name.trim() !== '' && effectiveId !== '' && !collides

  // Changing the type of a variable that already holds data is allowed but lossy in
  // meaning: values that do not fit are KEPT as they were typed rather than blanked,
  // so the column would read as `date` while holding free text. Say so before the
  // save rather than after — this is why a retype appeared to "not work" on a filled
  // variable and to work on an empty one.
  const stale = useMemo(() => {
    if (!editing || type === column.type) return []
    return (values ?? []).filter((v) => !fitsColumnType(v, type))
  }, [editing, type, column, values])

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    setSubmitted(true)
    try {
      await onSubmit({
        id: effectiveId,
        name: name.trim(),
        type,
        label: cleanLocalized(label),
        description: cleanLocalized(description),
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
          <FormField label={t('datasets.col_name')} hint={t('datasets.col_name_hint')} hintInTooltip required>
            {({ id: fid }) => (
              <Input
                id={fid}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            )}
          </FormField>
          <FormField label={t('datasets.column_type')}>
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

        {collides && (
          <p className="text-xs text-destructive">{t('datasets.col_id_taken')}</p>
        )}

        {stale.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
            <p className="text-xs text-foreground">
              {t('patient_data.collection_retype_warning', {
                count: stale.length,
                type: t(`datasets.type_${type}`),
              })}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {stale.slice(0, 3).map((v) => String(v)).join(', ')}
              {stale.length > 3 && ` … (+${stale.length - 3})`}
            </p>
          </div>
        )}

        <FormField
          label={t('datasets.col_meta_label')}
          hint={t('datasets.col_meta_label_hint')}
          hintInTooltip
        >
          {({ id: fid }) => (
            <Input
              id={fid}
              value={localizedRaw(label, language)}
              onChange={(e) => setLabel(setLocalized(label, language, e.target.value))}
              placeholder={name}
            />
          )}
        </FormField>

        <FormField label={t('datasets.col_meta_description')}>
          {({ id: fid }) => (
            <Textarea
              id={fid}
              value={localizedRaw(description, language)}
              onChange={(e) => setDescription(setLocalized(description, language, e.target.value))}
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
