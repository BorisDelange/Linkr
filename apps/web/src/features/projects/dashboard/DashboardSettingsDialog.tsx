import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Dashboard, DashboardFilterColumn } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'

interface DashboardSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  dashboard: Dashboard
  projectUid: string
}

export function DashboardSettingsDialog({
  open,
  onOpenChange,
  dashboard,
  projectUid,
}: DashboardSettingsDialogProps) {
  const { t } = useTranslation()
  const { updateDashboard } = useDashboardStore()
  const { files: datasetFiles } = useDatasetStore()

  const [datasetFileId, setDatasetFileId] = useState<string | null>(dashboard.datasetFileId)
  const [filterConfig, setFilterConfig] = useState<DashboardFilterColumn[]>(dashboard.filterConfig)
  const [showWidgetTitles, setShowWidgetTitles] = useState(dashboard.showWidgetTitles ?? true)

  // Reset local state when dialog opens
  useEffect(() => {
    if (open) {
      setDatasetFileId(dashboard.datasetFileId)
      setFilterConfig(dashboard.filterConfig)
      setShowWidgetTitles(dashboard.showWidgetTitles ?? true)
    }
  }, [open, dashboard.datasetFileId, dashboard.filterConfig, dashboard.showWidgetTitles])

  const projectDatasetFiles = datasetFiles.filter(
    (f) => f.projectUid === projectUid && f.type === 'file' && f.columns && f.columns.length > 0
  )

  const selectedDatasetFile = datasetFiles.find((f) => f.id === datasetFileId)
  const availableColumns = selectedDatasetFile?.columns ?? []

  // Columns not yet added to filter config
  const unusedColumns = useMemo(() => {
    const usedIds = new Set(filterConfig.map((fc) => fc.columnId))
    return availableColumns.filter((c) => !usedIds.has(c.id))
  }, [availableColumns, filterConfig])

  const handleSave = () => {
    // Only keep filters for columns that still exist in the selected dataset
    const validColumnIds = new Set(availableColumns.map((c) => c.id))
    const validFilters = filterConfig.filter((fc) => validColumnIds.has(fc.columnId))

    updateDashboard(dashboard.id, {
      datasetFileId,
      filterConfig: validFilters,
      showWidgetTitles,
    })
    onOpenChange(false)
  }

  const addFilterColumn = (columnId: string) => {
    const col = availableColumns.find((c) => c.id === columnId)
    if (!col) return

    // Auto-detect type from column type
    let type: DashboardFilterColumn['type'] = 'categorical'
    if (col.type === 'number') {
      type = 'numeric'
    } else if (col.type === 'date') {
      type = 'date'
    }

    setFilterConfig((prev) => [...prev, { columnId, type, label: col.name }])
  }

  const removeFilterColumn = (columnId: string) => {
    setFilterConfig((prev) => prev.filter((fc) => fc.columnId !== columnId))
  }

  const changeFilterType = (columnId: string, type: DashboardFilterColumn['type']) => {
    setFilterConfig((prev) =>
      prev.map((fc) => (fc.columnId === columnId ? { ...fc, type } : fc))
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('dashboard.settings_title')}</DialogTitle>
          <DialogDescription>{t('dashboard.settings_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Dataset selection */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t('dashboard.field_dataset')}</Label>
            <Select
              value={datasetFileId ?? '__none__'}
              onValueChange={(v) => setDatasetFileId(v === '__none__' ? null : v)}
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder={t('dashboard.field_dataset_placeholder')} />
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={4}>
                <SelectItem value="__none__">{t('dashboard.field_dataset_none')}</SelectItem>
                {projectDatasetFiles.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    <div className="flex items-center gap-2">
                      <Database size={12} className="text-muted-foreground" />
                      {f.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t('dashboard.field_dataset_hint')}</p>
          </div>

          {/* Filter column configuration */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">{t('dashboard.settings_filters')}</Label>
            <p className="text-[11px] text-muted-foreground">{t('dashboard.settings_filters_hint')}</p>

            {filterConfig.length > 0 && (
              <div className="space-y-1.5">
                {filterConfig.map((fc) => {
                  const col = availableColumns.find((c) => c.id === fc.columnId)
                  return (
                    <div key={fc.columnId} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                      <span className="flex-1 truncate text-xs">{fc.label ?? col?.name ?? fc.columnId}</span>
                      <Select
                        value={fc.type}
                        onValueChange={(v) => changeFilterType(fc.columnId, v as DashboardFilterColumn['type'])}
                      >
                        <SelectTrigger className="h-6 w-28 text-[11px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" sideOffset={4}>
                          <SelectItem value="categorical">{t('dashboard.filter_type_categorical')}</SelectItem>
                          <SelectItem value="numeric">{t('dashboard.filter_type_numeric')}</SelectItem>
                          <SelectItem value="date">{t('dashboard.filter_type_date')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => removeFilterColumn(fc.columnId)}
                      >
                        <X size={12} />
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}

            {datasetFileId && unusedColumns.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 w-full justify-start gap-1.5 text-xs text-muted-foreground">
                    <Plus size={12} />
                    {t('dashboard.settings_add_filter')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-60 overflow-y-auto">
                  {unusedColumns.map((col) => (
                    <DropdownMenuItem key={col.id} onClick={() => addFilterColumn(col.id)}>
                      {col.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {!datasetFileId && (
              <p className="text-xs text-muted-foreground italic">{t('dashboard.settings_filters_no_dataset')}</p>
            )}
          </div>

          {/* Widget title bars toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-xs font-medium">{t('dashboard.show_widget_titles')}</Label>
              <p className="text-[11px] text-muted-foreground">{t('dashboard.show_widget_titles_hint')}</p>
            </div>
            <Switch checked={showWidgetTitles} onCheckedChange={setShowWidgetTitles} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleSave}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
