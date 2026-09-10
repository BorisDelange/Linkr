import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip'
import { FormField } from '@/components/ui/form-field'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { displayColumnName } from '@/lib/dataset-utils'
import { detectDatasetRoles } from '@/lib/patient-data/dataset-role-detection'
import type { DatasetTimelineMapping } from '@/lib/patient-data/dataset-timeline'
import type { SchemaMapping } from '@/types/schema-mapping'
import type { DatasetFile } from '@/types'
import { TypeBadge } from '@/features/projects/lab/datasets/TypeBadge'

const NONE = '__none__'

interface Role {
  key: keyof DatasetTimelineMapping
  labelKey: string
  optional: boolean
  /** Shown behind an info icon, for a role whose name does not say enough. */
  hintKey?: string
}

/**
 * The role dropdowns, grouped as they are read.
 *
 * Three per row, one row per question the mapping answers: who the row is about,
 * when it happened, what it is, and what it holds. A flat list of nine made the
 * reader match label to meaning one by one.
 */
const ROLE_ROWS: Role[][] = [
  [
    { key: 'personColumn', labelKey: 'patient_data.dataset_person_column', optional: false },
    { key: 'visitColumn', labelKey: 'patient_data.dataset_visit_column', optional: true },
    { key: 'visitDetailColumn', labelKey: 'patient_data.dataset_visit_detail_column', optional: true },
  ],
  [
    {
      key: 'dateColumn',
      labelKey: 'patient_data.dataset_start_datetime_column',
      optional: false,
      hintKey: 'patient_data.dataset_datetime_hint',
    },
    {
      key: 'endColumn',
      labelKey: 'patient_data.dataset_end_datetime_column',
      optional: true,
      hintKey: 'patient_data.dataset_datetime_hint',
    },
  ],
  [
    { key: 'conceptCodeColumn', labelKey: 'patient_data.dataset_code_column', optional: true },
    { key: 'labelColumn', labelKey: 'patient_data.dataset_label_column', optional: true },
  ],
  [
    { key: 'valueColumn', labelKey: 'patient_data.dataset_value_column', optional: true },
    { key: 'textValueColumn', labelKey: 'patient_data.dataset_text_value_column', optional: true },
  ],
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The mapping being edited; absent when adding one. */
  mapping?: Partial<DatasetTimelineMapping>
  datasets: DatasetFile[]
  /** Columns of the dataset currently chosen, resolved by the caller (lazy in server mode). */
  columnsOf: (datasetFileId: string | undefined) => DatasetFile['columns']
  schemaMapping?: SchemaMapping
  onSubmit: (mapping: Partial<DatasetTimelineMapping>) => void
}

/**
 * One dialog for adding and editing a dataset's column mapping.
 *
 * Same questions either way, so one dialog: which dataset, and which of its columns
 * carry the patient, the dates and the values. Keeping this out of the config panel
 * matters because there are nine roles — inline they buried the rest of the
 * timeline's settings, and the picked series had nowhere to sit.
 *
 * `detectDatasetRoles` fills in what the column names give away as soon as a dataset
 * is chosen, so this is usually a confirmation rather than nine choices.
 */
export function DatasetMappingDialog({
  open, onOpenChange, mapping, datasets, columnsOf, schemaMapping, onSubmit,
}: Props) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const editing = mapping != null

  const [draft, setDraft] = useState<Partial<DatasetTimelineMapping>>({})

  // Re-seeded on open so the dialog never shows the previous dataset's mapping, and
  // so cancelling discards whatever was chosen.
  useEffect(() => {
    if (!open) return
    setDraft(mapping ? { ...mapping } : {})
  }, [open, mapping])

  const columns = columnsOf(draft.datasetFileId) ?? []

  // Runs on open and again when the columns land (server mode resolves them lazily),
  // filling only roles still unset — so a saved mapping is never overwritten.
  useEffect(() => {
    if (!open || columns.length === 0) return
    setDraft((d) => {
      const found = detectDatasetRoles(columns, d, schemaMapping)
      return Object.keys(found).length ? { ...d, ...found } : d
    })
  }, [open, columns, schemaMapping])

  const valid = !!(draft.datasetFileId && draft.personColumn && draft.dateColumn)

  const pickDataset = (v: string) => {
    // A different dataset invalidates every column and code chosen for the previous
    // one — they name columns that no longer exist, and would plot nothing.
    setDraft(v === NONE ? {} : { datasetFileId: v })
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      // Three role dropdowns to a row need more than `settings`' max-w-lg.
      className="sm:max-w-3xl"
      title={editing
        ? t('patient_data.dataset_edit_mapping')
        : t('patient_data.dataset_add')}
      onConfirm={() => { if (valid) { onSubmit(draft); onOpenChange(false) } }}
      confirmLabel={editing ? t('common.save') : t('common.add')}
      confirmDisabled={!valid}
    >
      <div className="space-y-4">
        <FormField label={t('patient_data.dataset')} required>
          {({ id }) => (
            <Select value={draft.datasetFileId ?? NONE} onValueChange={pickDataset}>
              <SelectTrigger id={id} className="h-7 text-xs">
                <SelectValue placeholder={t('patient_data.dataset_pick')} />
              </SelectTrigger>
              <SelectContent>
                {datasets.map((f) => (
                  <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>

        {draft.datasetFileId && (
          <TooltipProvider delayDuration={300}>
            <div className="space-y-3">
              {ROLE_ROWS.map((row, i) => (
                <div key={i} className="grid grid-cols-3 gap-3">
                  {row.map(({ key, labelKey, optional, hintKey }) => (
                    <div key={key} className="space-y-1">
                      <Label className="flex items-center gap-1">
                        {t(labelKey)}
                        {!optional && <span className="text-destructive">*</span>}
                        {hintKey && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info size={11} className="shrink-0 text-muted-foreground" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs text-xs">
                              {t(hintKey)}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </Label>
                      <Select
                        value={(draft[key] as string) || NONE}
                        onValueChange={(v) => setDraft((d) => ({
                          ...d, [key]: v === NONE ? undefined : v,
                        }))}
                      >
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue placeholder={t('patient_data.dataset_pick_column')} />
                        </SelectTrigger>
                        <SelectContent>
                          {optional && <SelectItem value={NONE}>{t('common.none')}</SelectItem>}
                          {columns.map((col) => (
                            <SelectItem key={col.id} value={col.id}>
                              <span className="flex items-center gap-2">
                                <TypeBadge type={col.type} size="sm" />
                                {displayColumnName(col, lang)}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </TooltipProvider>
        )}
      </div>
    </DialogShell>
  )
}
