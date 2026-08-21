import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Database } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DialogShell } from '@/components/ui/dialog-shell'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type {
  DashboardFilter,
  DashboardFilterScope,
  DashboardTab,
  DashboardWidget,
  DatasetColumn,
  DatasetFile,
  DatePreset,
} from '@/types'
import { localized } from '@/lib/localized'

/** The editable shape of a filter, shared by the add and edit flows. */
export interface FilterDraft {
  datasetFileId: string | null
  columnId: string | null
  label: string
  inputType: DashboardFilter['inputType']
  scope: DashboardFilterScope
  datePresets: DatePreset[]
}

function emptyDraft(): FilterDraft {
  return {
    datasetFileId: null,
    columnId: null,
    label: '',
    inputType: 'multi-select',
    scope: { type: 'all' },
    datePresets: [],
  }
}

interface FilterConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Absent when adding — the dialog then starts empty and picks a dataset first. */
  filter?: DashboardFilter
  datasetFiles: DatasetFile[]
  /** Datasets a widget actually uses; the only ones offered when adding. */
  availableDatasets: DatasetFile[]
  tabs: DashboardTab[]
  widgets: DashboardWidget[]
  language: 'en' | 'fr'
  onSubmit: (draft: FilterDraft) => void
  /** Renders the scope picker — passed in to avoid duplicating it here. */
  renderScope: (scope: DashboardFilterScope, onChange: (s: DashboardFilterScope) => void) => React.ReactNode
  /** Renders the column picker — same reason. */
  renderColumnPicker: (
    columns: DatasetColumn[],
    value: string | null,
    onChange: (columnId: string) => void,
  ) => React.ReactNode
  /** Renders the date-preset editor, shown only for date columns. */
  renderDatePresets: (presets: DatePreset[], onChange: (p: DatePreset[]) => void) => React.ReactNode
  /** Input-type options for a filter type — owned by the sidebar. */
  getInputTypeOptions: (type: DashboardFilter['type']) => { value: DashboardFilter['inputType']; label: string }[]
  /** Maps a column to its filter type + default input widget. */
  detectColumnDefaults: (col: DatasetColumn | undefined) => {
    type: DashboardFilter['type']
    inputType: DashboardFilter['inputType']
  }
}

/**
 * Add/edit a dashboard filter in one dialog: dataset, column, label, input type,
 * scope and (for dates) quick ranges. The add flow used to offer only dataset +
 * column + input type in the sidebar, so a new filter could not be labelled or
 * scoped without being created first and then edited.
 */
export function FilterConfigDialog({
  open,
  onOpenChange,
  filter,
  datasetFiles,
  availableDatasets,
  language,
  onSubmit,
  renderScope,
  renderColumnPicker,
  renderDatePresets,
  getInputTypeOptions,
  detectColumnDefaults,
}: FilterConfigDialogProps) {
  const { t } = useTranslation()
  const isEdit = !!filter

  const [draft, setDraft] = useState<FilterDraft>(emptyDraft)

  // Seed from the filter being edited (or reset for a fresh add) each time the dialog opens.
  useEffect(() => {
    if (!open) return
    if (filter) {
      const cols = datasetFiles.find((f) => f.id === filter.datasetFileId)?.columns ?? []
      // A legacy filter's stored columnId can be stale; resolve by name like the runtime does.
      const currentColumnId = cols.find((c) => c.name === filter.columnName)?.id ?? filter.columnId
      setDraft({
        datasetFileId: filter.datasetFileId,
        columnId: currentColumnId,
        label: localized(filter.label, language),
        inputType: filter.inputType,
        scope: filter.scope ?? { type: 'all' },
        datePresets: filter.datePresets ?? [],
      })
    } else {
      setDraft(emptyDraft())
    }
  }, [open, filter, datasetFiles, language])

  const dsFile = draft.datasetFileId ? datasetFiles.find((f) => f.id === draft.datasetFileId) : null
  const columns = dsFile?.columns ?? []
  const selectedColumn = columns.find((c) => c.id === draft.columnId)
  const filterType = detectColumnDefaults(selectedColumn).type
  const inputTypeOptions = getInputTypeOptions(filterType)

  const handleColumnChange = (columnId: string) => {
    const col = columns.find((c) => c.id === columnId)
    // Re-derive the input widget from the new column: a range picker makes no
    // sense once the filter points at a string column.
    const { inputType } = detectColumnDefaults(col)
    setDraft((d) => ({ ...d, columnId, inputType }))
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? t('dashboard.filter_edit_title') : t('dashboard.filter_add_title')}
      onConfirm={() => onSubmit(draft)}
      confirmLabel={isEdit ? t('common.save') : t('common.add')}
      confirmDisabled={!draft.datasetFileId || !draft.columnId}
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>{t('dashboard.filter_select_dataset')}</Label>
          <Select
            value={draft.datasetFileId ?? ''}
            // Changing dataset invalidates the column, so clear it.
            onValueChange={(v) => setDraft((d) => ({ ...d, datasetFileId: v, columnId: null }))}
            // The dataset is fixed once the filter exists: re-pointing it at another
            // dataset would silently orphan the column and any active value.
            disabled={isEdit}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={t('dashboard.filter_select_dataset')} />
            </SelectTrigger>
            <SelectContent position="popper" sideOffset={4}>
              {(isEdit ? datasetFiles : availableDatasets).map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  <div className="flex items-center gap-2">
                    <Database size={11} className="text-muted-foreground" />
                    {f.name}
                  </div>
                </SelectItem>
              ))}
              {!isEdit && availableDatasets.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t('dashboard.filter_no_datasets')}
                </div>
              )}
            </SelectContent>
          </Select>
        </div>

        {draft.datasetFileId && (
          <div className="space-y-1.5">
            <Label>{t('dashboard.filter_select_column')}</Label>
            {renderColumnPicker(columns, draft.columnId, handleColumnChange)}
          </div>
        )}

        {draft.columnId && (
          <>
            <div className="space-y-1.5">
              <Label>{t('dashboard.filter_label')}</Label>
              <Input
                value={draft.label}
                placeholder={selectedColumn?.name ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                className="h-8 text-xs"
              />
            </div>

            {inputTypeOptions.length > 1 && (
              <div className="space-y-1.5">
                <Label>{t('dashboard.filter_input_type')}</Label>
                <Select
                  value={draft.inputType}
                  onValueChange={(v) => setDraft((d) => ({ ...d, inputType: v as DashboardFilter['inputType'] }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" sideOffset={4}>
                    {inputTypeOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value} className="text-xs">
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {renderScope(draft.scope, (scope) => setDraft((d) => ({ ...d, scope })))}

            {filterType === 'date' &&
              renderDatePresets(draft.datePresets, (datePresets) => setDraft((d) => ({ ...d, datePresets })))}
          </>
        )}
      </div>
    </DialogShell>
  )
}
