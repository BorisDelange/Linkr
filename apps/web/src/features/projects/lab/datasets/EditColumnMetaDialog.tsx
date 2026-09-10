import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FormField } from '@/components/ui/form-field'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fetchColumnDistinct } from '@/lib/api/datasets'
import { CATEGORICAL_MAX_DISTINCT } from './use-column-distinct'
import { isServerMode } from '@/lib/api-client'
import { useDatasetStore } from '@/stores/dataset-store'
import { localizedRaw, seedLocalizedForEditing, setLocalized } from '@/lib/localized'
import type { DatasetColumn, LocalizedString } from '@/types'

interface Props {
  fileId: string
  column: DatasetColumn
  /** In-memory rows (local mode) used to derive distinct values without a round-trip. */
  rows: Record<string, unknown>[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Categorical columns get a value-label editor; numeric/boolean/date don't. */
function isCategorical(col: DatasetColumn): boolean {
  return col.type === 'string' || col.type === 'unknown'
}

export function EditColumnMetaDialog({ fileId, column, rows, open, onOpenChange }: Props) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const updateColumnMeta = useDatasetStore((s) => s.updateColumnMeta)

  // The parent remounts this dialog per column (key={column.id}), so props-derived
  // initial state is safe and no reset effect is needed.
  //
  // Label and description are multilingual, edited one language at a time — the
  // active UI language, as everywhere else in the app (organisations, profiles,
  // dashboards). Seeded on open so a language never entered starts from the other
  // one instead of blank, then held as a LocalizedString so switching the UI
  // language mid-edit does not overwrite the language already stored.
  const seededLabel = useMemo(
    () => seedLocalizedForEditing(column.label, language), [column.label, language],
  )
  const seededDescription = useMemo(
    () => seedLocalizedForEditing(column.description, language), [column.description, language],
  )
  const [label, setLabel] = useState<LocalizedString>(seededLabel)
  const [description, setDescription] = useState<LocalizedString>(seededDescription)
  const [valueLabels, setValueLabels] = useState<Record<string, string>>(column.valueLabels ?? {})
  const [required, setRequired] = useState(column.required ?? false)
  const [withTime, setWithTime] = useState(column.withTime ?? false)
  const [allowed, setAllowed] = useState((column.allowedValues ?? []).join('\n'))
  const [min, setMin] = useState(column.min == null ? '' : String(column.min))
  const [max, setMax] = useState(column.max == null ? '' : String(column.max))
  // Server-fetched distinct codes (server mode only); local mode derives them from rows below.
  const [serverDistinct, setServerDistinct] = useState<string[]>([])

  const categorical = isCategorical(column)

  // Local mode: distinct codes are derived state from the in-memory rows, not an
  // external system — compute with useMemo rather than an effect.
  const localDistinct = useMemo(() => {
    if (!categorical || isServerMode()) return []
    const seen = new Set<string>()
    for (const row of rows) {
      const v = row[column.id]
      if (v == null || v === '') continue
      seen.add(String(v))
      if (seen.size > CATEGORICAL_MAX_DISTINCT) break
    }
    return [...seen]
  }, [categorical, rows, column.id])

  // Server mode: fetch DISTINCT once when the dialog opens.
  useEffect(() => {
    if (!open || !categorical || !isServerMode()) return
    let cancelled = false
    fetchColumnDistinct(fileId, column.id, { limit: CATEGORICAL_MAX_DISTINCT })
      .then((res) => { if (!cancelled) setServerDistinct(res.values) })
      .catch(() => { if (!cancelled) setServerDistinct([]) })
    return () => { cancelled = true }
  }, [open, fileId, column.id, categorical])

  // Union of live distinct codes and any already-mapped codes (kept even if a code
  // no longer appears in the data), so an existing mapping is never silently dropped.
  const codes = useMemo(() => {
    const set = new Set<string>([...localDistinct, ...serverDistinct])
    for (const code of Object.keys(column.valueLabels ?? {})) set.add(code)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [localDistinct, serverDistinct, column.valueLabels])

  // Nothing to save until something actually changed. Blank entries are dropped
  // before comparing: typing a label and clearing it again is not a change, and
  // an empty string would otherwise persist as a "label" that renders as blank.
  const cleanedValueLabels = useMemo(
    () => Object.fromEntries(Object.entries(valueLabels).filter(([, v]) => v.trim() !== '')),
    [valueLabels],
  )
  const allowedValues = useMemo(
    () => allowed.split('\n').map((v) => v.trim()).filter(Boolean),
    [allowed],
  )
  // Compared against the SEEDED values, not the stored ones: pre-filling a blank
  // language from the other one is a convenience, and measuring it as an edit would
  // open the dialog already dirty.
  const dirty =
    JSON.stringify(label) !== JSON.stringify(seededLabel) ||
    JSON.stringify(description) !== JSON.stringify(seededDescription) ||
    required !== (column.required ?? false) ||
    withTime !== (column.withTime ?? false) ||
    min !== (column.min == null ? '' : String(column.min)) ||
    max !== (column.max == null ? '' : String(column.max)) ||
    JSON.stringify(allowedValues) !== JSON.stringify(column.allowedValues ?? []) ||
    JSON.stringify(cleanedValueLabels) !== JSON.stringify(column.valueLabels ?? {})

  const handleSave = () => {
    if (!dirty) return
    updateColumnMeta(fileId, column.id, {
      label, description, valueLabels: cleanedValueLabels,
      required, withTime, allowedValues,
      // Numeric bounds are stored as numbers so comparisons don't sort "10" before
      // "9"; date bounds stay ISO strings, which already sort chronologically.
      min: min === '' ? undefined : column.type === 'number' ? Number(min) : min,
      max: max === '' ? undefined : column.type === 'number' ? Number(max) : max,
    })
    onOpenChange(false)
  }

  // Cmd/Ctrl+S saves the dialog, matching the save shortcut used across the app.
  // A ref holds the latest submit intent so the listener stays stable across renders.
  const submitRef = useRef<() => void>(() => {})
  useEffect(() => { submitRef.current = handleSave })
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        submitRef.current()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={t('datasets.col_edit')}
      description={t('datasets.col_meta_desc', { name: column.name })}
      onConfirm={handleSave}
      confirmLabel={t('common.save')}
      confirmDisabled={!dirty}
      dirtyTracked
    >
          <FormField label={t('datasets.col_meta_label')}>
            {({ id }) => (
              <Input
                id={id}
                value={localizedRaw(label, language)}
                onChange={(e) => setLabel(setLocalized(label, language, e.target.value))}
                placeholder={column.name}
              />
            )}
          </FormField>

          <FormField
            label={t('datasets.col_meta_description')}
          >
            {({ id }) => (
              <Textarea
                id={id}
                value={localizedRaw(description, language)}
                onChange={(e) => setDescription(setLocalized(description, language, e.target.value))}
                rows={3}
              />
            )}
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label={t('datasets.col_min')}>
              {({ id }) => (
                <Input
                  id={id}
                  type={column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text'}
                  value={min}
                  onChange={(e) => setMin(e.target.value)}
                  disabled={column.type !== 'number' && column.type !== 'date'}
                />
              )}
            </FormField>
            <FormField label={t('datasets.col_max')}>
              {({ id }) => (
                <Input
                  id={id}
                  type={column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text'}
                  value={max}
                  onChange={(e) => setMax(e.target.value)}
                  disabled={column.type !== 'number' && column.type !== 'date'}
                />
              )}
            </FormField>
          </div>

          {categorical && (
            <FormField
              label={t('datasets.col_allowed_values')}
              hint={t('datasets.col_allowed_values_hint')}
              hintInTooltip
            >
              {({ id }) => (
                <Textarea
                  id={id}
                  value={allowed}
                  onChange={(e) => setAllowed(e.target.value)}
                  rows={3}
                  placeholder={'yes\nno\nunknown'}
                />
              )}
            </FormField>
          )}

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={required} onCheckedChange={(v) => setRequired(v === true)} />
              {t('datasets.col_required')}
            </label>
            {column.type === 'date' && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={withTime} onCheckedChange={(v) => setWithTime(v === true)} />
                {t('datasets.col_with_time')}
              </label>
            )}
          </div>

          {categorical && codes.length > 0 && (
            <FormField
              label={t('datasets.col_meta_value_labels')}
              hint={t('datasets.col_meta_value_labels_hint')}
            >
              {/* An explicit height, not max-h: ScrollArea's viewport is h-full,
                  so a max-height on the root never bounds it and the list
                  overflows the dialog instead of scrolling. Sized to the rows
                  it holds, capped at 14rem — a short list should not leave a
                  gaping empty box. */}
              {() => (
              <ScrollArea
                className="rounded-md border"
                style={{ height: Math.min(codes.length * 34 + 2, 224) }}
              >
                <div className="divide-y">
                  {codes.map((code) => (
                    <div key={code} className="flex items-center gap-2 px-2 py-1.5">
                      <code className="w-2/5 shrink-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs" title={code}>
                        {code}
                      </code>
                      <Input
                        value={valueLabels[code] ?? ''}
                        onChange={(e) => setValueLabels((prev) => ({ ...prev, [code]: e.target.value }))}
                        placeholder={code}
                        className="h-7 text-xs"
                      />
                    </div>
                  ))}
                </div>
              </ScrollArea>
              )}
            </FormField>
          )}
    </DialogShell>
  )
}
