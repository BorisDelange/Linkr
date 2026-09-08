import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTallestPanel } from '@/hooks/use-tallest-panel'
import { columnId as deriveColumnId } from '@/lib/column-id'
import { useDatasetStore } from '@/stores/dataset-store'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { TypeBadge } from '@/features/projects/lab/datasets/TypeBadge'
import { EditColumnMetaDialog } from '@/features/projects/lab/datasets/EditColumnMetaDialog'
import { usePatientChartContext } from '../PatientChartContext'
import { identityColumnsFromMapping } from './identity-columns'
import { resolveVariables } from './variables'
import type { DatasetColumn, PatientCollectionConfig, PatientCollectionVariable } from '@/types'

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
 * Configures a board's manual collection, in three tabs: which dataset receives it
 * and how its columns identify the patient (Dataset), which columns are filled in
 * from the chart (Variables), and how entries are saved (General).
 *
 * The Variables tab rests on one distinction: a **variable is a reference to a
 * column**, not a column itself. One created here owns its column, so removing it
 * removes the column; one pointing at a column the dataset already had only stops
 * being collected — the dataset had it first, and other things may read it.
 *
 * A variable's label and description are its COLUMN's own metadata, so naming one
 * here names it in the Datasets page too rather than inventing a second name.
 */
export function CollectionSetupDialog({ open, onOpenChange, boardId, config }: Props) {
  const { t } = useTranslation()
  const { schemaMapping } = usePatientChartContext()
  const files = useDatasetStore((s) => s.files)
  const createFileWithData = useDatasetStore((s) => s.createFileWithData)
  const ensureServerMeta = useDatasetStore((s) => s.ensureServerMeta)
  const applyOps = useDatasetStore((s) => s.applyOps)
  const getFileRows = useDatasetStore((s) => s.getFileRows)
  const updateDashboard = usePatientChartStore((s) => s.updateDashboard)

  const [tab, setTab] = useState('dataset')
  const [draft, setDraft] = useState<Partial<PatientCollectionConfig>>(config ?? {})
  const [newName, setNewName] = useState('')
  const [newColumn, setNewColumn] = useState('')
  const [newColumnType, setNewColumnType] = useState<DatasetColumn['type']>('string')
  const [metaColumn, setMetaColumn] = useState<DatasetColumn | null>(null)
  const [removing, setRemoving] = useState<{ variable: PatientCollectionVariable; filled: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const { containerProps, measuredPanelProps } = useTallestPanel()

  const datasets = files.filter((f) => f.type === 'file')
  const selected = datasets.find((f) => f.id === draft.datasetFileId)
  const columns = selected?.columns ?? []

  // Server mode loads a dataset's columns lazily (the tree listing carries none),
  // so without this every column dropdown below stays empty forever.
  useEffect(() => {
    if (draft.datasetFileId) ensureServerMeta(draft.datasetFileId)
  }, [draft.datasetFileId, ensureServerMeta])

  const identityIds = [draft.personColumn, draft.visitColumn, draft.visitDetailColumn]
  const variables = resolveVariables(draft.variables, columns, identityIds)
  const collected = new Set(variables.map((v) => v.columnId))
  const available = columns.filter(
    (c) => !identityIds.includes(c.id) && !collected.has(c.id),
  )
  const columnOf = (id: string) => columns.find((c) => c.id === id)
  const setVariables = (next: PatientCollectionVariable[]) =>
    setDraft((d) => ({ ...d, variables: next }))

  /**
   * Create a dataset already carrying the three identity columns, named the way
   * the ACTIVE DATABASE names them (`subject_id`/`hadm_id` on MIMIC, not a generic
   * `person_id`) — so the collection joins to the warehouse without a rename, and
   * reads familiarly to whoever fills it.
   */
  const createDataset = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    try {
      const cols: DatasetColumn[] = identityColumnsFromMapping(schemaMapping).map((col, i) => ({
        id: deriveColumnId(col.name), name: col.name, type: 'string', order: i,
      }))
      const fileId = await createFileWithData(`${name}.csv`, null, cols, [])
      setDraft({
        datasetFileId: fileId,
        personColumn: cols[0]?.id,
        visitColumn: cols[1]?.id,
        visitDetailColumn: cols[2]?.id,
        variables: [],
      })
      setNewName('')
      setTab('variables')
    } finally {
      setBusy(false)
    }
  }

  /** Add a column to the dataset and collect it — this variable owns that column. */
  const createVariable = async () => {
    const name = newColumn.trim()
    if (!name || !draft.datasetFileId || columns.some((c) => c.id === deriveColumnId(name))) return
    setBusy(true)
    try {
      const columnId = deriveColumnId(name)
      await applyOps(draft.datasetFileId, [{
        id: crypto.randomUUID(), at: Date.now(), group: crypto.randomUUID(),
        type: 'addColumn', column: columnId, name, colType: newColumnType,
      }])
      setVariables([...variables, { columnId, origin: 'created' }])
      setNewColumn('')
    } finally {
      setBusy(false)
    }
  }

  const requestRemove = (variable: PatientCollectionVariable) => {
    // An existing column outlives the collection: only stop referencing it.
    if (variable.origin === 'existing') {
      setVariables(variables.filter((v) => v.columnId !== variable.columnId))
      return
    }
    // A created one owns its column, so removing it destroys whatever was entered.
    // Count that first — an empty column is not worth a confirmation.
    const rows = draft.datasetFileId ? getFileRows(draft.datasetFileId) : []
    const filled = rows.filter((r) => {
      const v = r[variable.columnId]
      return v != null && v !== ''
    }).length
    if (filled === 0) void dropVariable(variable)
    else setRemoving({ variable, filled })
  }

  const dropVariable = async (variable: PatientCollectionVariable) => {
    if (!draft.datasetFileId) return
    await applyOps(draft.datasetFileId, [{
      id: crypto.randomUUID(), at: Date.now(), group: crypto.randomUUID(),
      type: 'removeColumn', column: variable.columnId,
    }])
    setVariables(variables.filter((v) => v.columnId !== variable.columnId))
    setRemoving(null)
  }

  const save = () => {
    if (!draft.datasetFileId || !draft.personColumn) return
    updateDashboard(boardId, { collection: { ...draft, variables } as PatientCollectionConfig })
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

  const datasetPanel = (
    <div className="space-y-4">
      <FormField label={t('patient_data.collection_dataset')}>
        {() => (
          <Select
            value={draft.datasetFileId ?? NONE}
            onValueChange={(v) => setDraft(v === NONE ? {} : { datasetFileId: v })}
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
              <Button variant="outline" disabled={!newName.trim() || busy} onClick={() => void createDataset()}>
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
    </div>
  )

  const variablesPanel = !selected ? (
    <p className="text-xs text-muted-foreground">{t('patient_data.collection_pick_dataset_first')}</p>
  ) : (
    <div className="space-y-4">
      <div className="space-y-1">
        {variables.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('patient_data.collection_no_variables_yet')}</p>
        ) : (
          variables.map((variable) => {
            const col = columnOf(variable.columnId)
            if (!col) return null
            const created = variable.origin === 'created'
            return (
              <div key={variable.columnId} className="flex items-center gap-2 rounded border px-2 py-1.5">
                <TypeBadge type={col.type} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">{col.label ?? col.name}</div>
                  {col.description && (
                    <div className="truncate text-[10px] text-muted-foreground">{col.description}</div>
                  )}
                </div>
                {!created && <Badge variant="outline">{t('patient_data.collection_existing_column')}</Badge>}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={t('datasets.col_edit_meta')}
                  onClick={() => setMetaColumn(col)}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={created
                    ? t('patient_data.collection_delete_column')
                    : t('patient_data.collection_stop_collecting')}
                  onClick={() => requestRemove(variable)}
                >
                  {created ? <Trash2 className="size-3.5" /> : <X className="size-3.5" />}
                </Button>
              </div>
            )
          })
        )}
      </div>

      <FormField
        label={t('patient_data.collection_add_variable')}
        hint={t('patient_data.collection_add_variable_hint')}
      >
        {({ id }) => (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                id={id}
                value={newColumn}
                onChange={(e) => setNewColumn(e.target.value)}
                placeholder={t('patient_data.collection_new_variable')}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createVariable() } }}
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
              <Button variant="outline" disabled={!newColumn.trim() || busy} onClick={() => void createVariable()}>
                <Plus className="size-3.5" />
              </Button>
            </div>

            {available.length > 0 && (
              <Select
                value={NONE}
                onValueChange={(v) => {
                  if (v !== NONE) setVariables([...variables, { columnId: v, origin: 'existing' }])
                }}
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue placeholder={t('patient_data.collection_use_existing')} />
                </SelectTrigger>
                <SelectContent>
                  {available.map((col) => (
                    <SelectItem key={col.id} value={col.id}>
                      <span className="flex items-center gap-2">
                        <TypeBadge type={col.type} size="sm" />
                        {col.label ?? col.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
      </FormField>
    </div>
  )

  const generalPanel = (
    <FormField
      label={t('patient_data.collection_save_mode')}
      hint={t('patient_data.collection_save_mode_hint')}
    >
      {({ id }) => (
        <Select
          value={draft.saveMode ?? 'auto'}
          onValueChange={(v) => setDraft((d) => ({ ...d, saveMode: v as 'auto' | 'manual' }))}
        >
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t('patient_data.collection_save_auto')}</SelectItem>
            <SelectItem value="manual">{t('patient_data.collection_save_manual')}</SelectItem>
          </SelectContent>
        </Select>
      )}
    </FormField>
  )

  const panels: [string, React.ReactNode][] = [
    ['dataset', datasetPanel],
    ['variables', variablesPanel],
    ['general', generalPanel],
  ]
  const removedColumn = removing ? columnOf(removing.variable.columnId) : undefined

  return (
    <>
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
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full">
            <TabsTrigger value="dataset" className="flex-1">
              {t('patient_data.collection_tab_dataset')}
            </TabsTrigger>
            <TabsTrigger value="variables" className="flex-1">
              {t('patient_data.collection_tab_variables')}
            </TabsTrigger>
            <TabsTrigger value="general" className="flex-1">
              {t('common.tab_general')}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Sized to the tallest panel from the first frame, so switching tabs never
            moves the triggers out from under the pointer. */}
        <div {...containerProps} className="mt-3">
          {panels.map(([key, panel]) => (
            <div key={key} {...measuredPanelProps(key)} hidden={tab !== key}>
              {panel}
            </div>
          ))}
        </div>
      </DialogShell>

      {/* A variable's label and description ARE its column's metadata, so this is
          the same editor the Datasets page uses — not a second set of names. */}
      {metaColumn && draft.datasetFileId && (
        <EditColumnMetaDialog
          key={metaColumn.id}
          fileId={draft.datasetFileId}
          column={metaColumn}
          rows={[]}
          open
          onOpenChange={(o) => { if (!o) setMetaColumn(null) }}
        />
      )}

      <AlertDialog open={removing != null} onOpenChange={(o) => { if (!o) setRemoving(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('patient_data.collection_delete_column')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('patient_data.collection_delete_column_confirm', {
                name: removedColumn?.label ?? removedColumn?.name ?? '',
                count: removing?.filled ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (removing) void dropVariable(removing.variable) }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
