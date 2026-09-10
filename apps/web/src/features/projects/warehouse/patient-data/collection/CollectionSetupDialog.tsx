import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Info, Pencil, Plus, Trash2, X } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTallestPanel } from '@/hooks/use-tallest-panel'
import { columnId as deriveColumnId } from '@/lib/column-id'
import { displayColumnDescription, displayColumnName } from '@/lib/dataset-utils'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { TypeBadge } from '@/features/projects/lab/datasets/TypeBadge'
import { CategoryDialog } from './CategoryDialog'
import { VariableDialog, type VariableDraft } from './VariableDialog'
import { usePatientChartContext } from '../PatientChartContext'
import { identityColumnsFromMapping, type IdentityColumn } from './identity-columns'
import { resolveVariables } from './variables'
import { localized } from '@/lib/localized'
import type {
  DatasetColumn, PatientCollectionCategory, PatientCollectionConfig, PatientCollectionVariable,
} from '@/types'

/** A copy of `list` with the items at `a` and `b` exchanged. */
function swap<T>(list: T[], a: number, b: number): T[] {
  const next = [...list]
  const tmp = next[a]
  next[a] = next[b]
  next[b] = tmp
  return next
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectUid: string
  boardId: string
  config: PatientCollectionConfig | undefined
}

const NONE = '__none__'
/** Past this many variables the list scrolls instead of growing the dialog. */
const VARIABLES_BEFORE_SCROLL = 8
const VARIABLES_MAX_HEIGHT = 320
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
export function CollectionSetupDialog({ open, onOpenChange, projectUid, boardId, config }: Props) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const { schemaMapping } = usePatientChartContext()
  const files = useDatasetStore((s) => s.files)
  const loadProjectDatasets = useDatasetStore((s) => s.loadProjectDatasets)
  const createFileWithData = useDatasetStore((s) => s.createFileWithData)
  const ensureServerMeta = useDatasetStore((s) => s.ensureServerMeta)
  const applyOps = useDatasetStore((s) => s.applyOps)
  const getFileRows = useDatasetStore((s) => s.getFileRows)
  const updateColumnMeta = useDatasetStore((s) => s.updateColumnMeta)
  const setColumnType = useDatasetStore((s) => s.setColumnType)
  const renameColumn = useDatasetStore((s) => s.renameColumn)
  const updateDashboard = usePatientChartStore((s) => s.updateDashboard)

  const [tab, setTab] = useState('dataset')
  const [draft, setDraft] = useState<Partial<PatientCollectionConfig>>(config ?? {})
  // Re-seeded each time the dialog opens, so closing it discards the edits rather
  // than holding them for the next visit — Close reads as "cancel" everywhere else.
  useEffect(() => { if (open) setDraft(config ?? {}) }, [open, config])
  const [newName, setNewName] = useState('')
  const [addingVariable, setAddingVariable] = useState(false)
  const [editingVariable, setEditingVariable] = useState<DatasetColumn | null>(null)
  const [removing, setRemoving] = useState<{ variable: PatientCollectionVariable; filled: number } | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)
  const [editingCategory, setEditingCategory] = useState<PatientCollectionCategory | null>(null)
  const [busy, setBusy] = useState(false)
  const { containerProps, measuredPanelProps } = useTallestPanel()

  // The datasets live in their own store, which only the Datasets page was loading —
  // so the dropdown below was empty for anyone who had not been there this session.
  // The store no-ops when this project's datasets are already scanned.
  const datasetsPath = useAppStore((s) => s._projectsRaw.find((p) => p.uid === projectUid)?.datasetsPath)
  useEffect(() => {
    if (open && projectUid) void loadProjectDatasets(projectUid, datasetsPath ?? undefined)
  }, [open, projectUid, datasetsPath, loadProjectDatasets])

  const datasets = files.filter((f) => f.type === 'file')
  const selected = datasets.find((f) => f.id === draft.datasetFileId)
  const columns = selected?.columns ?? []

  // Server mode loads a dataset's columns lazily (the tree listing carries none),
  // so without this every column dropdown below stays empty forever.
  //
  // Depends on `selected`, not on the id alone: `ensureServerMeta` no-ops while the
  // id is not in the store, which is the case whenever the dialog opens before the
  // scan above has landed. Keyed on the id only, the effect would not re-run once it
  // did, and the columns would never be fetched.
  useEffect(() => {
    if (selected) ensureServerMeta(selected.id)
  }, [selected, ensureServerMeta])

  // Pick an existing dataset and its identity columns fill themselves in, whenever
  // the dataset already carries a column named the way the active database names it
  // (`subject_id` on MIMIC, `person_id` on a stock CDM). Only fills what is still
  // unset, so it never overwrites a choice the user made or a saved configuration.
  useEffect(() => {
    if (!columns.length) return
    const guess = (role: IdentityColumn['role']) => {
      const wanted = identityColumnsFromMapping(schemaMapping).find((c) => c.role === role)?.name
      if (!wanted) return undefined
      return columns.find((c) => c.name.toLowerCase() === wanted.toLowerCase())?.id
    }
    setDraft((d) => {
      const next = { ...d }
      if (!next.personColumn) next.personColumn = guess('person')
      if (!next.visitColumn) next.visitColumn = guess('visit')
      if (!next.visitDetailColumn) next.visitDetailColumn = guess('visitDetail')
      const changed = (['personColumn', 'visitColumn', 'visitDetailColumn'] as const)
        .some((k) => next[k] !== d[k])
      return changed ? next : d
    })
  }, [columns, schemaMapping])

  const identityIds = [draft.personColumn, draft.visitColumn, draft.visitDetailColumn]
  const variables = resolveVariables(draft.variables, columns, identityIds)
  const collected = new Set(variables.map((v) => v.columnId))
  const available = columns.filter(
    (c) => !identityIds.includes(c.id) && !collected.has(c.id),
  )
  const columnOf = (id: string) => columns.find((c) => c.id === id)
  const setVariables = (next: PatientCollectionVariable[]) =>
    setDraft((d) => ({ ...d, variables: next }))

  const categories = draft.categories ?? []
  const setCategories = (next: PatientCollectionCategory[]) =>
    setDraft((d) => ({ ...d, categories: next }))

  /**
   * Removing a category never touches the variables it held: a category is a
   * heading, so deleting one re-files its variables as ungrouped rather than
   * destroying them. `groupVariables` already tolerates a dangling categoryId, but
   * clearing it here keeps the saved config honest.
   */
  const removeCategory = (id: string) => {
    setDraft((d) => ({
      ...d,
      categories: (d.categories ?? []).filter((c) => c.id !== id),
      variables: (d.variables ?? variables).map((v) => (
        v.categoryId === id ? { ...v, categoryId: undefined } : v
      )),
    }))
  }

  const upsertCategory = (category: PatientCollectionCategory) => {
    setCategories(categories.some((c) => c.id === category.id)
      ? categories.map((c) => (c.id === category.id ? category : c))
      : [...categories, category])
  }

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
        id: deriveColumnId(col.name), name: col.name, type: col.type, order: i,
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
  const createVariable = async (v: VariableDraft) => {
    if (!draft.datasetFileId) return
    const group = crypto.randomUUID()
    await applyOps(draft.datasetFileId, [{
      id: crypto.randomUUID(), at: Date.now(), group,
      type: 'addColumn', column: v.id, name: v.name, colType: v.type,
    }])
    // Metadata and constraints are column properties, not ops — the log records what
    // the DATA is, and a label is not data.
    updateColumnMeta(draft.datasetFileId, v.id, {
      label: v.label, description: v.description,
      required: v.required, withTime: v.withTime,
      allowedValues: v.allowedValues, min: v.min, max: v.max,
    })
    setVariables([...variables, { columnId: v.id, origin: 'created' }])
  }

  /** Save an edit to an existing variable. The type can change; the id cannot. */
  const editVariable = async (v: VariableDraft) => {
    if (!draft.datasetFileId) return
    const current = columnOf(v.id)
    if (current && current.type !== v.type) {
      await setColumnType(draft.datasetFileId, v.id, v.type)
    }
    // The name is the CSV header, so changing it is a real rename: it rewrites the
    // column id and repairs every stored reference to it. Skipping this left the
    // dialog's edits to the name silently dropped.
    let id = v.id
    if (current && current.name !== v.name) {
      await renameColumn(draft.datasetFileId, v.id, v.name)
      // The id is derived from the name, so the metadata below has to target the id
      // the column now has, not the one it was opened with.
      id = deriveColumnId(v.name)
      setVariables(variables.map((variable) => (
        variable.columnId === v.id ? { ...variable, columnId: id } : variable
      )))
    }
    updateColumnMeta(draft.datasetFileId, id, {
      label: v.label, description: v.description,
      required: v.required, withTime: v.withTime,
      allowedValues: v.allowedValues, min: v.min, max: v.max,
    })
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
    updateDashboard(boardId, {
      collection: { ...draft, variables, categories } as PatientCollectionConfig,
    })
    onOpenChange(false)
  }

  const columnSelect = (
    key: 'personColumn' | 'visitColumn' | 'visitDetailColumn',
    label: string,
    optional = false,
  ) => (
    <FormField label={label} required={!optional}>
      {({ id }) => (
        <Select
          value={draft[key] || NONE}
          onValueChange={(v) => setDraft((d) => ({ ...d, [key]: v === NONE ? undefined : v }))}
        >
          <SelectTrigger id={id} className="h-7 text-xs">
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
      )}
    </FormField>
  )

  const datasetPanel = (
    <div className="space-y-4">
      <FormField label={t('patient_data.collection_dataset')} required>
        {({ id }) => (
          <Select
            value={draft.datasetFileId ?? NONE}
            onValueChange={(v) => setDraft(v === NONE ? {} : { datasetFileId: v })}
          >
            <SelectTrigger id={id}>
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
      {/* Scrolls past a dozen or so variables rather than growing the dialog off the
          screen. An explicit height, not max-h: ScrollArea's viewport is h-full, so a
          max-height on the root never bounds it. */}
      <div
        className={variables.length > VARIABLES_BEFORE_SCROLL ? 'overflow-y-auto pr-1' : undefined}
        style={variables.length > VARIABLES_BEFORE_SCROLL ? { maxHeight: VARIABLES_MAX_HEIGHT } : undefined}
      >
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
                  <div className="truncate text-xs">{displayColumnName(col, lang)}</div>
                  {displayColumnDescription(col, lang) && (
                    <div className="truncate text-[10px] text-muted-foreground">
                      {displayColumnDescription(col, lang)}
                    </div>
                  )}
                </div>
                {!created && <Badge variant="outline">{t('patient_data.collection_existing_column')}</Badge>}
                {categories.length > 0 && (
                  <Select
                    value={variable.categoryId ?? NONE}
                    onValueChange={(v) => setVariables(variables.map((x) => (
                      x.columnId === variable.columnId
                        ? { ...x, categoryId: v === NONE ? undefined : v }
                        : x
                    )))}
                  >
                    <SelectTrigger className="h-7 w-36 shrink-0 text-[10px]">
                      <SelectValue placeholder={t('patient_data.collection_no_category')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('patient_data.collection_no_category')}</SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{localized(c.name, lang)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={t('datasets.col_edit')}
                  onClick={() => setEditingVariable(col)}
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
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setAddingVariable(true)}>
          <Plus className="mr-1.5 size-3.5" />
          {t('patient_data.collection_add_variable')}
        </Button>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help text-muted-foreground">
                <Info className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {t('patient_data.collection_add_variable_hint')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {available.length > 0 && (
          <Select
            value={NONE}
            onValueChange={(v) => {
              if (v !== NONE) setVariables([...variables, { columnId: v, origin: 'existing' }])
            }}
          >
            <SelectTrigger className="h-8 flex-1 text-xs">
              <SelectValue placeholder={t('patient_data.collection_use_existing')} />
            </SelectTrigger>
            <SelectContent>
              {available.map((col) => (
                <SelectItem key={col.id} value={col.id}>
                  <span className="flex items-center gap-2">
                    <TypeBadge type={col.type} size="sm" />
                    {displayColumnName(col, lang)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  )

  const categoriesPanel = !selected ? (
    <p className="text-xs text-muted-foreground">{t('patient_data.collection_pick_dataset_first')}</p>
  ) : (
    <div className="space-y-4">
      <div className="space-y-1">
        {categories.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('patient_data.collection_no_categories_yet')}
          </p>
        ) : (
          categories.map((category, i) => {
            const count = variables.filter((v) => v.categoryId === category.id).length
            return (
              <div key={category.id} className="flex items-center gap-2 rounded border px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">{localized(category.name, lang)}</div>
                  {localized(category.description, lang) && (
                    <div className="truncate text-[10px] text-muted-foreground">
                      {localized(category.description, lang)}
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {t('patient_data.collection_n_variables', { count })}
                </span>
                {/* Order is the render order, so moving one is how a form is
                    arranged — there is no other place to express it. */}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={i === 0}
                  title={t('common.move_up')}
                  onClick={() => setCategories(swap(categories, i, i - 1))}
                >
                  <ChevronUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={i === categories.length - 1}
                  title={t('common.move_down')}
                  onClick={() => setCategories(swap(categories, i, i + 1))}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={t('common.edit')}
                  onClick={() => setEditingCategory(category)}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={t('common.delete')}
                  onClick={() => removeCategory(category.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            )
          })
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setAddingCategory(true)}>
          <Plus className="mr-1.5 size-3.5" />
          {t('patient_data.collection_add_category')}
        </Button>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help text-muted-foreground">
                <Info className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {t('patient_data.collection_add_category_hint')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )

  const generalPanel = (
    <FormField
      label={t('patient_data.collection_save_mode')}
      hint={t('patient_data.collection_save_mode_hint')}
      hintInTooltip
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
    ['categories', categoriesPanel],
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
        // Wider than a stock settings dialog: the type dropdowns hold labels like
        // "Date / datetime" that a narrower column truncates to uselessness.
        className="sm:max-w-2xl"
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
            <TabsTrigger value="categories" className="flex-1">
              {t('patient_data.collection_tab_categories')}
            </TabsTrigger>
            <TabsTrigger value="general" className="flex-1">
              {t('common.tab_general')}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Below the tabs, not above: as a dialog description it pushed the tabs
            down and described only the first of the three panels. */}
        <p className="mt-3 text-xs text-muted-foreground">
          {t('patient_data.collection_setup_description')}
        </p>

        {/* Sized to the tallest panel from the first frame, so switching tabs never
            moves the triggers out from under the pointer.

            EVERY panel is absolutely positioned, the visible one included, so none of
            them contributes height and the container's size comes only from the
            hook's measurement. With the active panel in normal flow it set the
            container's height itself, and `minHeight` could only ever push that up —
            so the dialog still grew and shrank as the active panel's own height
            changed. Inactive panels are additionally invisible and inert so nothing
            paints or takes focus; `hidden` would collapse them to zero and they would
            measure as nothing. */}
        <div className="relative mt-3" {...containerProps}>
          {panels.map(([key, panel]) => {
            const active = key === tab
            return (
              <div
                key={key}
                aria-hidden={!active}
                inert={!active || undefined}
                {...measuredPanelProps(key)}
                className={cn(
                  'absolute inset-x-0 top-0 flex min-w-0 flex-col',
                  !active && 'pointer-events-none invisible',
                )}
              >
                {panel}
              </div>
            )
          })}
        </div>
      </DialogShell>

      {/* One dialog for both: adding and editing a variable ask the same questions,
          so splitting them would make the options depend on when they were set. */}
      {draft.datasetFileId && (
        <VariableDialog
          open={addingVariable || editingVariable != null}
          onOpenChange={(o) => { if (!o) { setAddingVariable(false); setEditingVariable(null) } }}
          column={editingVariable ?? undefined}
          takenIds={columns.map((c) => c.id)}
          onSubmit={(v) => (editingVariable ? editVariable(v) : createVariable(v))}
        />
      )}

      <CategoryDialog
        open={addingCategory || editingCategory != null}
        onOpenChange={(o) => { if (!o) { setAddingCategory(false); setEditingCategory(null) } }}
        category={editingCategory ?? undefined}
        onSubmit={upsertCategory}
      />

      <AlertDialog open={removing != null} onOpenChange={(o) => { if (!o) setRemoving(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('patient_data.collection_delete_column')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('patient_data.collection_delete_column_confirm', {
                name: removedColumn ? displayColumnName(removedColumn, lang) : '',
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
