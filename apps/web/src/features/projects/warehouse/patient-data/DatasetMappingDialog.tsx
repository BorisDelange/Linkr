import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
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
 * One dialog for adding and editing a DATASET CONCEPT: one variable to plot.
 *
 * A dataset is wide — one column per variable, `heart_rate_value` paired with its
 * own `heart_rate_datetime` — so there is no code or label column to group rows by,
 * and nothing in the data says the two columns belong together. The pairing is
 * therefore DECLARED here, one variable at a time, and named by hand: the name is
 * what the legend shows, the equivalent of a concept's name.
 *
 * `detectDatasetRoles` fills in the identity and date columns from their names, so
 * this is usually a confirmation plus the two columns that are actually specific to
 * this variable.
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

  // A named variable pointing at a value column and its date: that is the whole
  // contract. Without a name the legend has nothing to call it; without a value
  // column there is nothing to draw.
  const valid = !!(
    draft.datasetFileId && draft.personColumn && draft.dateColumn
    && draft.seriesName?.trim()
  )

  const pickDataset = (v: string) => {
    // A different dataset invalidates every column chosen for the previous one —
    // they name columns that no longer exist, and would plot nothing. The typed
    // name is kept: it describes the variable, not the file it came from.
    setDraft((d) => (v === NONE ? {} : { datasetFileId: v, seriesName: d.seriesName }))
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      // Three role dropdowns to a row need more than `settings`' max-w-lg.
      className="sm:max-w-3xl"
      title={editing
        ? t('patient_data.dataset_concept_edit')
        : t('patient_data.dataset_concept_add')}
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
          <FormField
            label={t('patient_data.dataset_series_name')}
            hint={t('patient_data.dataset_series_name_hint')}
            hintInTooltip
            required
          >
            {({ id }) => (
              <Input
                id={id}
                value={draft.seriesName ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, seriesName: e.target.value }))}
                placeholder={t('patient_data.dataset_series_name_placeholder')}
              />
            )}
          </FormField>
        )}

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
