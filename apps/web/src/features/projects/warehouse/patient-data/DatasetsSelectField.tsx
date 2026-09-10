import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { groupsByCode, type DatasetTimelineMapping } from '@/lib/patient-data/dataset-timeline'
import { useAppStore } from '@/stores/app-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { DatasetMappingDialog } from './DatasetMappingDialog'
import { DatasetSeriesPickerDialog } from './DatasetSeriesPickerDialog'
import { usePatientChartContext } from './PatientChartContext'
import { useDatasetRows } from './widgets/use-dataset-rows'
import type { PluginConfigField } from '@/types/plugin'

interface Props {
  field: PluginConfigField
  value: Partial<DatasetTimelineMapping>[] | undefined
  onChange: (value: Partial<DatasetTimelineMapping>[]) => void
  /** Series colours live beside the concept colours, keyed by synthetic id. */
  colors: Record<string, string>
  onColorsChange: (colors: Record<string, string>) => void
}

/**
 * The datasets a patient widget plots, one row each.
 *
 * A row is a whole dataset: its column mapping (edited in a dialog, since there are
 * nine roles) and the series picked out of it (the concept picker's own dialog,
 * since choosing series is the same task as choosing concepts). The row itself stays
 * a summary so the config panel keeps showing the timeline's other settings.
 */
export function DatasetsSelectField({
  field, value, onChange, colors, onColorsChange,
}: Props) {
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
  const [picking, setPicking] = useState<number | null>(null)

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

  const nameOf = (m: Partial<DatasetTimelineMapping>) =>
    datasets.find((f) => f.id === m.datasetFileId)?.name ?? t('patient_data.dataset')

  const submitMapping = (m: Partial<DatasetTimelineMapping>) => {
    if (editing == null) return
    onChange(editing < 0
      ? [...mappings, m]
      : mappings.map((x, i) => (i === editing ? m : x)))
  }

  // The picker needs the dataset's rows to count patients and rows per series.
  // Fetched only while it is open: the config panel itself never needs them.
  const pickingMapping = picking != null ? mappings[picking] : undefined
  const pickingFileId = pickingMapping?.datasetFileId
  const { byFileId } = useDatasetRows(
    useMemo(() => (pickingFileId ? [pickingFileId] : []), [pickingFileId]),
    !!pickingFileId,
  )

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
              const grouped = groupsByCode(mapping as DatasetTimelineMapping)
              const picked = mapping.codes?.length ?? 0

              return (
                <div key={index} className="rounded-md border px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {nameOf(mapping)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title={t('patient_data.dataset_edit_mapping')}
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

                  {/* Filtering is mandatory once the rows carry a code or a label: a
                      dataset routinely holds hundreds of series, and drawing them
                      all would make the chart unreadable. A dataset with neither is
                      a single series and has nothing to pick. */}
                  {grouped && (
                    <Button
                      size="sm-tight"
                      variant={picked > 0 ? 'default' : 'outline'}
                      className="mt-1.5 w-full justify-start"
                      onClick={() => setPicking(index)}
                    >
                      <ListChecks size={13} />
                      {picked > 0
                        ? t('patient_data.dataset_series_picked', { count: picked })
                        : t('patient_data.dataset_pick_series')}
                    </Button>
                  )}
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
              {t('patient_data.dataset_add')}
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
        onSubmit={submitMapping}
      />

      {picking != null && pickingMapping?.datasetFileId && (
        <DatasetSeriesPickerDialog
          open
          onOpenChange={(o) => { if (!o) setPicking(null) }}
          rows={byFileId[pickingMapping.datasetFileId] ?? []}
          mapping={pickingMapping as DatasetTimelineMapping}
          colors={colors}
          onConfirm={(codes, nextColors) => {
            onChange(mappings.map((m, i) => (i === picking ? { ...m, codes } : m)))
            onColorsChange(nextColors)
            setPicking(null)
          }}
        />
      )}
    </>
  )
}
