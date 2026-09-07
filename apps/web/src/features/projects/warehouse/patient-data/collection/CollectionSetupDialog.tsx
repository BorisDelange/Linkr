import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  const updateDashboard = usePatientChartStore((s) => s.updateDashboard)

  const [draft, setDraft] = useState<Partial<PatientCollectionConfig>>(config ?? {})
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const datasets = files.filter((f) => f.type === 'file')
  const selected = datasets.find((f) => f.id === draft.datasetFileId)
  const columns = selected?.columns ?? []

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
    </DialogShell>
  )
}
