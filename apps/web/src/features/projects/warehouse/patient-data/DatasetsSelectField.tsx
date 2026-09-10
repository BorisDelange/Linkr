import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, ListFilter, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { displayColumnName } from '@/lib/dataset-utils'
import { detectDatasetRoles } from '@/lib/patient-data/dataset-role-detection'
import { groupsByCode, type DatasetTimelineMapping } from '@/lib/patient-data/dataset-timeline'
import { useAppStore } from '@/stores/app-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { TypeBadge } from '@/features/projects/lab/datasets/TypeBadge'
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

const NONE = '__none__'

/** The role dropdowns, in the order they are declared. */
const ROLES: {
  key: keyof DatasetTimelineMapping
  labelKey: string
  optional: boolean
}[] = [
  { key: 'personColumn', labelKey: 'patient_data.dataset_person_column', optional: false },
  { key: 'visitColumn', labelKey: 'patient_data.dataset_visit_column', optional: true },
  { key: 'visitDetailColumn', labelKey: 'patient_data.dataset_visit_detail_column', optional: true },
  { key: 'dateColumn', labelKey: 'patient_data.dataset_date_column', optional: false },
  { key: 'endColumn', labelKey: 'patient_data.dataset_end_column', optional: true },
  { key: 'valueColumn', labelKey: 'patient_data.dataset_value_column', optional: true },
  { key: 'textValueColumn', labelKey: 'patient_data.dataset_text_value_column', optional: true },
  { key: 'conceptCodeColumn', labelKey: 'patient_data.dataset_code_column', optional: true },
  { key: 'labelColumn', labelKey: 'patient_data.dataset_label_column', optional: true },
]

/**
 * Binds a patient widget to one or more datasets: which datasets, which of their
 * columns carry the patient, the dates and the values, and which of their series
 * are worth drawing.
 *
 * None of that can be inferred the way OMOP is — a dataset has no schema mapping —
 * so the mapping is part of the widget's config. `detectDatasetRoles` fills in what
 * the column names give away, which is most of it for a dataset that came out of the
 * warehouse; the dropdowns are then a correction rather than nine choices.
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

  // The widget config can be opened without ever visiting the Datasets page, and
  // the store only scans a project's datasets on demand — without this the dropdown
  // below is empty for anyone who has not been there this session.
  useEffect(() => {
    if (projectUid) void loadProjectDatasets(projectUid, datasetsPath ?? undefined)
  }, [projectUid, datasetsPath, loadProjectDatasets])

  const datasets = useMemo(() => files.filter((f) => f.type === 'file'), [files])

  // Columns load lazily in server mode. Depends on the file objects, not on the
  // ids: `ensureServerMeta` no-ops while an id is not in the store yet, so keyed on
  // the id the effect would never re-run once the scan landed.
  const chosen = useMemo(
    () => mappings.map((m) => datasets.find((f) => f.id === m.datasetFileId)).filter(Boolean),
    [mappings, datasets],
  )
  useEffect(() => {
    for (const f of chosen) if (f) void ensureServerMeta(f.id)
  }, [chosen, ensureServerMeta])

  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const [picking, setPicking] = useState<number | null>(null)

  const patch = useCallback((index: number, changes: Partial<DatasetTimelineMapping>) => {
    onChange(mappings.map((m, i) => (i === index ? { ...m, ...changes } : m)))
  }, [mappings, onChange])

  // Auto-detection runs whenever a dataset's columns are known and a role is still
  // unset — which covers both "just picked a dataset" and "columns just landed from
  // the server", the latter arriving well after the field first rendered.
  //
  // It writes back through `onChange`, so it MUST converge: `detectDatasetRoles`
  // only ever fills blanks and returns `{}` once there is nothing left to fill, and
  // the effect writes nothing in that case. Without both halves this would loop
  // forever — the parent hands back a fresh array identity on every render.
  useEffect(() => {
    let next = mappings
    let changed = false
    mappings.forEach((m, i) => {
      const file = datasets.find((f) => f.id === m.datasetFileId)
      if (!file?.columns?.length) return
      const found = detectDatasetRoles(file.columns, m, schemaMapping)
      if (Object.keys(found).length === 0) return
      next = next.map((x, j) => (j === i ? { ...x, ...found } : x))
      changed = true
    })
    if (changed) onChange(next)
  }, [mappings, datasets, schemaMapping, onChange])

  const addDataset = () => {
    onChange([...mappings, {}])
    setExpanded((prev) => ({ ...prev, [mappings.length]: true }))
  }

  const removeDataset = (index: number) => {
    onChange(mappings.filter((_, i) => i !== index))
    setExpanded({})
  }

  // The picker needs the dataset's rows to count patients and rows per series.
  // Fetched only while a picker is open: the config panel itself never needs them.
  const pickingMapping = picking != null ? mappings[picking] : undefined
  const pickingFileId = pickingMapping?.datasetFileId
  const { byFileId } = useDatasetRows(
    useMemo(() => (pickingFileId ? [pickingFileId] : []), [pickingFileId]),
    !!pickingFileId,
  )

  const canPick = (m: Partial<DatasetTimelineMapping>) =>
    !!(m.datasetFileId && m.personColumn && m.dateColumn)

  return (
    <>
      <FormField
        label={field.label[lang] ?? field.label.en}
        hint={field.description ? (field.description[lang] ?? field.description.en) : undefined}
        hintInTooltip
      >
        {() => (
          <div className="space-y-2">
            {mappings.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t('patient_data.dataset_none_added')}
              </p>
            )}

            {mappings.map((mapping, index) => {
              const file = datasets.find((f) => f.id === mapping.datasetFileId)
              const columns = file?.columns ?? []
              const open = expanded[index] ?? false
              const grouped = groupsByCode(mapping as DatasetTimelineMapping)
              const picked = mapping.codes?.length ?? 0

              return (
                <div key={index} className="rounded-md border">
                  <div className="flex items-center gap-1 px-1.5 py-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 shrink-0"
                      onClick={() => setExpanded((prev) => ({ ...prev, [index]: !open }))}
                      aria-label={open ? t('common.collapse') : t('common.expand')}
                    >
                      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </Button>
                    <Select
                      value={mapping.datasetFileId ?? NONE}
                      onValueChange={(v) => patch(index, {
                        // A different dataset invalidates every column and code
                        // chosen for the previous one — they name columns that no
                        // longer exist, and would silently plot nothing.
                        datasetFileId: v === NONE ? undefined : v,
                        personColumn: undefined,
                        visitColumn: undefined,
                        visitDetailColumn: undefined,
                        dateColumn: undefined,
                        endColumn: undefined,
                        valueColumn: undefined,
                        textValueColumn: undefined,
                        conceptCodeColumn: undefined,
                        labelColumn: undefined,
                        codes: undefined,
                      } as Partial<DatasetTimelineMapping>)}
                    >
                      <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
                        <SelectValue placeholder={t('patient_data.dataset_pick')} />
                      </SelectTrigger>
                      <SelectContent>
                        {datasets.map((f) => (
                          <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {grouped && (
                      <Badge variant={picked > 0 ? 'secondary' : 'outline'} className="shrink-0">
                        {picked}
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeDataset(index)}
                      aria-label={t('common.remove')}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>

                  {open && file && (
                    <div className="space-y-2 border-t px-2 py-2">
                      {ROLES.map(({ key, labelKey, optional }) => (
                        <div key={key} className="space-y-1">
                          <Label>
                            {t(labelKey)}
                            {!optional && <span className="ml-0.5 text-destructive">*</span>}
                          </Label>
                          <Select
                            value={(mapping[key] as string) || NONE}
                            onValueChange={(v) => patch(index, {
                              [key]: v === NONE ? undefined : v,
                            } as Partial<DatasetTimelineMapping>)}
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

                      {/* Filtering is mandatory once the rows carry a code or a
                          label: a dataset routinely holds hundreds of series, and
                          drawing them all would make the chart unreadable. */}
                      {grouped && (
                        <div className="space-y-1 border-t pt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 w-full text-xs"
                            disabled={!canPick(mapping)}
                            onClick={() => setPicking(index)}
                          >
                            <ListFilter size={13} className="mr-1.5" />
                            {picked > 0
                              ? t('patient_data.dataset_series_picked', { count: picked })
                              : t('patient_data.dataset_pick_series')}
                          </Button>
                          {!canPick(mapping) && (
                            <p className="text-[10px] text-muted-foreground">
                              {t('patient_data.dataset_pick_series_blocked')}
                            </p>
                          )}
                          {canPick(mapping) && picked === 0 && (
                            <p className="text-[10px] text-muted-foreground">
                              {t('patient_data.dataset_no_series_plots_nothing')}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            <Button variant="outline" size="sm" className="h-7 w-full text-xs" onClick={addDataset}>
              <Plus size={13} className="mr-1.5" />
              {t('patient_data.dataset_add')}
            </Button>
          </div>
        )}
      </FormField>

      {picking != null && pickingMapping && canPick(pickingMapping) && (
        <DatasetSeriesPickerDialog
          open
          onOpenChange={(o) => { if (!o) setPicking(null) }}
          rows={byFileId[pickingMapping.datasetFileId!] ?? []}
          mapping={pickingMapping as DatasetTimelineMapping}
          colors={colors}
          onConfirm={(codes, nextColors) => {
            patch(picking, { codes })
            onColorsChange(nextColors)
            setPicking(null)
          }}
        />
      )}
    </>
  )
}
