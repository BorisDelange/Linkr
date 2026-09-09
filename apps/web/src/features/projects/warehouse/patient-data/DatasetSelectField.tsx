import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { displayColumnName } from '@/lib/dataset-utils'
import { FormField } from '@/components/ui/form-field'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useDatasetStore } from '@/stores/dataset-store'
import type { PluginConfigField } from '@/types/plugin'
import type { DatasetTimelineMapping } from '@/lib/patient-data/dataset-timeline'
import { TypeBadge } from '@/features/projects/lab/datasets/TypeBadge'

interface Props {
  field: PluginConfigField
  value: Partial<DatasetTimelineMapping> | undefined
  onChange: (value: Partial<DatasetTimelineMapping> | undefined) => void
}

const NONE = '__none__'

/**
 * Binds a patient widget to a dataset: which dataset, and which of its columns
 * carry the patient, the visit, the date and the value.
 *
 * None of that can be inferred the way OMOP is — a dataset has no schema mapping —
 * so the mapping is part of the widget's config. It is the price of plotting
 * hand-collected data beside the warehouse's own, on one axis.
 */
export function DatasetSelectField({ field, value, onChange }: Props) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const files = useDatasetStore((s) => s.files)
  const ensureServerMeta = useDatasetStore((s) => s.ensureServerMeta)

  const datasets = files.filter((f) => f.type === 'file')
  const selected = datasets.find((f) => f.id === value?.datasetFileId)
  const columns = selected?.columns ?? []

  // Columns load lazily in server mode; without this the dropdowns stay empty.
  useEffect(() => {
    if (value?.datasetFileId) ensureServerMeta(value.datasetFileId)
  }, [value?.datasetFileId, ensureServerMeta])

  const patch = (changes: Partial<DatasetTimelineMapping>) => {
    if (!value?.datasetFileId && !changes.datasetFileId) return
    onChange({ ...value, ...changes } as Partial<DatasetTimelineMapping>)
  }

  const columnSelect = (
    key: keyof DatasetTimelineMapping,
    label: string,
    optional = false,
  ) => (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select
        value={(value?.[key] as string) || NONE}
        onValueChange={(v) => patch({ [key]: v === NONE ? undefined : v } as Partial<DatasetTimelineMapping>)}
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
  )

  return (
    <FormField
      label={field.label[lang] ?? field.label.en}
      hint={field.description ? (field.description[lang] ?? field.description.en) : undefined}
    >
      {() => (
        <div className="space-y-2">
          <Select
            value={value?.datasetFileId ?? NONE}
            onValueChange={(v) =>
              onChange(v === NONE ? undefined : { ...value, datasetFileId: v } as Partial<DatasetTimelineMapping>)
            }
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue placeholder={t('patient_data.dataset_pick')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('common.none')}</SelectItem>
              {datasets.map((f) => (
                <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {selected && (
            <>
              {columnSelect('personColumn', t('patient_data.dataset_person_column'))}
              {/* Optional: a dataset collected per patient rather than per stay
                  has no visit column, and then shows on every visit. */}
              {columnSelect('visitColumn', t('patient_data.dataset_visit_column'), true)}
              {columnSelect('dateColumn', t('patient_data.dataset_date_column'))}
              {columnSelect('endColumn', t('patient_data.dataset_end_column'), true)}
              {columnSelect('valueColumn', t('patient_data.dataset_value_column'), true)}
              {columnSelect('labelColumn', t('patient_data.dataset_label_column'), true)}
            </>
          )}
        </div>
      )}
    </FormField>
  )
}
