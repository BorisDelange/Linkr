import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { columnId as deriveColumnId } from '@/lib/column-id'
import { useDatasetStore } from '@/stores/dataset-store'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { TypeBadge } from '@/features/projects/lab/datasets/TypeBadge'
import { usePatientChartContext } from '../PatientChartContext'
import { identityColumnsFromMapping } from './identity-columns'
import type { DatasetColumn, PatientCollectionConfig } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectUid: string
  boardId: string
  config: PatientCollectionConfig | undefined
}

const NONE = '__none__'

const VARIABLE_TYPES: DatasetColumn['type'][] = ['string', 'number', 'boolean', 'date']

/**
 * Chooses the dataset that receives the collection and how its columns map onto
 * patient / hospitalisation / stay — or creates one already carrying those
 * columns, named as the active database names them.
 */
export function CollectionSetupDialog({ open, onOpenChange, boardId, config }: Props) {
  const { t } = useTranslation()
  const { schemaMapping } = usePatientChartContext()
  const files = useDatasetStore((s) => s.files)
  const createFileWithData = useDatasetStore((s) => s.createFileWithData)
  const applyOps = useDatasetStore((s) => s.applyOps)
  const ensureServerMeta = useDatasetStore((s) => s.ensureServerMeta)
  const updateDashboard = usePatientChartStore((s) => s.updateDashboard)

  const [draft, setDraft] = useState<Partial<PatientCollectionConfig>>(config ?? {})
  const [newName, setNewName] = useState('')
  const [newColumn, setNewColumn] = useState('')
  const [newColumnType, setNewColumnType] = useState<DatasetColumn['type']>('string')
  const [busy, setBusy] = useState(false)

  const identityIds = new Set(
    [draft.personColumn, draft.visitColumn, draft.visitDetailColumn].filter(Boolean) as string[],
  )

  const datasets = files.filter((f) => f.type === 'file')
  const selected = datasets.find((f) => f.id === draft.datasetFileId)
  const columns = selected?.columns ?? []

  // Server mode loads a dataset's columns lazily (the tree listing carries none),
  // so without this the column dropdowns below stay empty forever.
  useEffect(() => {
    if (draft.datasetFileId) ensureServerMeta(draft.datasetFileId)
  }, [draft.datasetFileId, ensureServerMeta])

  /**
   * Create a dataset already carrying the three identity columns, named the way
   * the ACTIVE DATABASE names them (`subject_id`/`hadm_id` on MIMIC, not a
   * generic `person_id`) — so the collection joins to the warehouse without a
   * rename, and reads familiarly to whoever fills it.
   */
  const createDataset = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    try {
      const identity = identityColumnsFromMapping(schemaMapping)
      const columns: DatasetColumn[] = identity.map((col, i) => ({
        id: deriveColumnId(col.name),
        name: col.name,
        type: 'string',
        order: i,
      }))
      const fileId = await createFileWithData(`${name}.csv`, null, columns, [])
      setDraft({
        datasetFileId: fileId,
        personColumn: columns[0]?.id,
        visitColumn: columns[1]?.id,
        visitDetailColumn: columns[2]?.id,
      })
      setNewName('')
    } finally {
      setBusy(false)
    }
  }

  /** Columns offered as collectable variables: everything but the identity ones. */
  const variableColumns = columns.filter((c) => !identityIds.has(c.id))

  /** Absent `variableColumns` means "all of them", so an unset config collects
   *  every non-identity column rather than nothing. */
  const isCollected = (colId: string) =>
    draft.variableColumns === undefined || draft.variableColumns.includes(colId)

  const toggleVariable = (colId: string) => {
    setDraft((d) => {
      const current = d.variableColumns ?? variableColumns.map((c) => c.id)
      const next = current.includes(colId)
        ? current.filter((id) => id !== colId)
        : [...current, colId]
      return { ...d, variableColumns: next }
    })
  }

  /** Add a column to the bound dataset and collect it straight away. */
  const addVariable = async () => {
    const name = newColumn.trim()
    if (!name || !draft.datasetFileId) return
    const id = deriveColumnId(name)
    if (columns.some((c) => c.id === id)) return
    setBusy(true)
    try {
      await applyOps(draft.datasetFileId, [{
        id: crypto.randomUUID(), at: Date.now(), group: crypto.randomUUID(),
        type: 'addColumn', column: id, name, colType: newColumnType,
      }])
      setDraft((d) => ({
        ...d,
        variableColumns: [...(d.variableColumns ?? variableColumns.map((c) => c.id)), id],
      }))
      setNewColumn('')
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    if (!draft.datasetFileId || !draft.personColumn) return
    updateDashboard(boardId, { collection: draft as PatientCollectionConfig })
    onOpenChange(false)
  }

  const columnSelect = (
    key: 'personColumn' | 'visitColumn' | 'visitDetailColumn',
    label: string,
    optional = false,
  ) => (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select
        value={draft[key] || NONE}
        onValueChange={(v) => setDraft((d) => ({ ...d, [key]: v === NONE ? undefined : v }))}
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
                {col.label ?? col.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={t('patient_data.collection_setup')}
      description={t('patient_data.collection_setup_description')}
      onConfirm={save}
      confirmLabel={t('common.save')}
      confirmDisabled={!draft.datasetFileId || !draft.personColumn}
      busy={busy}
    >
      <FormField label={t('patient_data.collection_dataset')}>
        {() => (
          <Select
            value={draft.datasetFileId ?? NONE}
            onValueChange={(v) =>
              setDraft(v === NONE ? {} : { datasetFileId: v })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder={t('patient_data.dataset_pick')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('common.none')}</SelectItem>
              {datasets.map((f) => (
                <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>

      {!draft.datasetFileId && (
        <FormField
          label={t('patient_data.collection_create_dataset')}
          hint={t('patient_data.collection_create_hint')}
        >
          {({ id }) => (
            <div className="flex gap-2">
              <Input
                id={id}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('patient_data.collection_dataset_placeholder')}
              />
              <Button
                variant="outline"
                disabled={!newName.trim() || busy}
                onClick={() => void createDataset()}
              >
                <Plus className="size-3.5" />
              </Button>
            </div>
          )}
        </FormField>
      )}

      {selected && (
        <div className="space-y-2">
          {columnSelect('personColumn', t('patient_data.dataset_person_column'))}
          {columnSelect('visitColumn', t('patient_data.dataset_visit_column'), true)}
          {columnSelect('visitDetailColumn', t('patient_data.collection_stay_column'), true)}
        </div>
      )}

      {selected && (
        <FormField
          label={t('patient_data.collection_variables')}
          hint={t('patient_data.collection_variables_hint')}
        >
          {() => (
            <div className="space-y-2">
              {variableColumns.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('patient_data.collection_no_variables_yet')}
                </p>
              ) : (
                <div className="space-y-1 rounded border p-2">
                  {variableColumns.map((col) => (
                    <label key={col.id} className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={isCollected(col.id)}
                        onCheckedChange={() => toggleVariable(col.id)}
                      />
                      <TypeBadge type={col.type} size="sm" />
                      <span className="min-w-0 flex-1 truncate">{col.label ?? col.name}</span>
                    </label>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <Input
                  value={newColumn}
                  onChange={(e) => setNewColumn(e.target.value)}
                  placeholder={t('patient_data.collection_new_variable')}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addVariable() } }}
                />
                <Select value={newColumnType} onValueChange={(v) => setNewColumnType(v as DatasetColumn['type'])}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VARIABLE_TYPES.map((ty) => (
                      <SelectItem key={ty} value={ty}>
                        <span className="flex items-center gap-2">
                          <TypeBadge type={ty} size="sm" />
                          {t(`datasets.type_${ty}`)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  disabled={!newColumn.trim() || busy}
                  onClick={() => void addVariable()}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </div>
          )}
        </FormField>
      )}
    </DialogShell>
  )
}
