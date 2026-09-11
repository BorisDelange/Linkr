import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConceptColorSwatch } from './ConceptColorSwatch'
import { FormField } from '@/components/ui/form-field'
import type { DatasetTimelineMapping } from '@/lib/patient-data/dataset-timeline'
import { useAppStore } from '@/stores/app-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { DatasetMappingDialog } from './DatasetMappingDialog'
import { usePatientChartContext } from './PatientChartContext'
import type { PluginConfigField } from '@/types/plugin'

interface Props {
  field: PluginConfigField
  value: Partial<DatasetTimelineMapping>[] | undefined
  /**
   * How many database concepts the widget already plots.
   *
   * Both sets share one chart and one rotating palette, so a dataset concept's
   * "auto" colour continues the sequence rather than restarting it — otherwise the
   * first dataset variable would always be the same red as the first concept.
   */
  conceptCount: number
  onChange: (value: Partial<DatasetTimelineMapping>[]) => void
}

/**
 * The dataset concepts a patient widget plots, one row each.
 *
 * A dataset concept is ONE variable: a name, the dataset it lives in, and the
 * columns holding its value and its date. That is the whole unit, because a wide
 * dataset pairs `heart_rate_value` with its own `heart_rate_datetime` and nothing
 * in the data says the two belong together — so the pairing is declared, one
 * variable at a time, exactly as a concept is picked one at a time.
 *
 * The row shows the variable's name with its file beside it: two datasets can hold
 * a "Heart rate", and the name alone would not say which is which.
 */
export function DatasetsSelectField({ field, value, conceptCount, onChange }: Props) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const { projectUid, schemaMapping } = usePatientChartContext()

  const files = useDatasetStore((s) => s.files)
  const loadProjectDatasets = useDatasetStore((s) => s.loadProjectDatasets)
  const ensureServerMeta = useDatasetStore((s) => s.ensureServerMeta)
  const datasetsPath = useAppStore(
    (s) => s._projectsRaw.find((p) => p.uid === projectUid)?.datasetsPath,
  )

  const mappings = useMemo(() => value ?? [], [value])

  // The widget config can be opened without ever visiting the Datasets page, and the
  // store only scans a project's datasets on demand — without this the dropdown in
  // the dialog is empty for anyone who has not been there this session.
  useEffect(() => {
    if (projectUid) void loadProjectDatasets(projectUid, datasetsPath ?? undefined)
  }, [projectUid, datasetsPath, loadProjectDatasets])

  const datasets = useMemo(() => files.filter((f) => f.type === 'file'), [files])

  /** `editing` is an index, or -1 while adding. Null means the dialog is closed. */
  const [editing, setEditing] = useState<number | null>(null)

  // Columns load lazily in server mode. Keyed on the file objects, not the ids:
  // `ensureServerMeta` no-ops while an id is not in the store yet, so keyed on the
  // id the effect would never re-run once the scan landed.
  const chosen = useMemo(
    () => mappings
      .map((m) => datasets.find((f) => f.id === m.datasetFileId))
      .filter((f): f is NonNullable<typeof f> => !!f),
    [mappings, datasets],
  )
  useEffect(() => {
    for (const f of chosen) void ensureServerMeta(f.id)
  }, [chosen, ensureServerMeta])

  // The dialog's own dataset may not be in `chosen` yet (it is being added), so it
  // resolves columns through this rather than reading the store itself.
  const columnsOf = useCallback((id: string | undefined) => {
    if (!id) return []
    void ensureServerMeta(id)
    return datasets.find((f) => f.id === id)?.columns ?? []
  }, [datasets, ensureServerMeta])

  /** The variable's own name; the file it comes from is the subtitle. */
  const nameOf = (m: Partial<DatasetTimelineMapping>) =>
    m.seriesName?.trim() || datasets.find((f) => f.id === m.datasetFileId)?.name
      || t('patient_data.dataset')

  const fileOf = (m: Partial<DatasetTimelineMapping>) =>
    datasets.find((f) => f.id === m.datasetFileId)?.name ?? ''

  const submitMapping = (m: Partial<DatasetTimelineMapping>) => {
    if (editing == null) return
    onChange(editing < 0
      ? [...mappings, m]
      : mappings.map((x, i) => (i === editing ? m : x)))
  }

  return (
    <>
      <FormField
        label={field.label[lang] ?? field.label.en}
        hint={field.description ? (field.description[lang] ?? field.description.en) : undefined}
        hintInTooltip
      >
        {() => (
          <div className="space-y-1.5">
            {mappings.map((mapping, index) => {
              // h-7, like every Select and Input around it: the row reads as one
              // more field in the form, not as a card sitting above them.
              return (
                <div key={index} className="rounded-md border px-2">
                  <div className="flex h-7 items-center gap-1">
                    <ConceptColorSwatch
                      value={mapping.color}
                      index={conceptCount + index}
                      onChange={(color) => onChange(
                        mappings.map((x, i) => (i === index ? { ...x, color } : x)),
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {nameOf(mapping)}
                    </span>
                    <span className="shrink-0 truncate text-[10px] text-muted-foreground">
                      {fileOf(mapping)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title={t('patient_data.dataset_concept_edit')}
                      onClick={() => setEditing(index)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-destructive"
                      title={t('common.remove')}
                      onClick={() => onChange(mappings.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}

            <Button
              variant="outline"
              size="sm-tight"
              className="w-full justify-start"
              onClick={() => setEditing(-1)}
            >
              <Plus size={13} />
              {t('patient_data.dataset_concept_add')}
            </Button>
          </div>
        )}
      </FormField>

      <DatasetMappingDialog
        open={editing != null}
        onOpenChange={(o) => { if (!o) setEditing(null) }}
        mapping={editing != null && editing >= 0 ? mappings[editing] : undefined}
        datasets={datasets}
        columnsOf={columnsOf}
        schemaMapping={schemaMapping}
        colorIndex={conceptCount + (editing != null && editing >= 0 ? editing : mappings.length)}
        onSubmit={submitMapping}
      />

    </>
  )
}
