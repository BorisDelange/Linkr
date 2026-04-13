import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Database } from 'lucide-react'
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { Dashboard } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'

interface DashboardSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  dashboard: Dashboard
  projectUid: string
  currentTabId?: string
}

export function DashboardSettingsDialog({
  open,
  onOpenChange,
  dashboard,
  projectUid,
  currentTabId,
}: DashboardSettingsDialogProps) {
  const { t } = useTranslation()
  const { updateDashboard, widgets, tabs, updateWidgetDataset } = useDashboardStore()
  const { files: datasetFiles } = useDatasetStore()

  const [showWidgetTitles, setShowWidgetTitles] = useState(dashboard.showWidgetTitles ?? true)
  const [defaultDatasetFileId, setDefaultDatasetFileId] = useState<string | null>(dashboard.defaultDatasetFileId ?? null)

  // Bulk-assign confirmation
  const [bulkAssignScope, setBulkAssignScope] = useState<'all' | 'tab' | null>(null)

  const projectDatasetFiles = useMemo(
    () => datasetFiles.filter(f => f.projectUid === projectUid && f.type === 'file' && f.columns && f.columns.length > 0),
    [datasetFiles, projectUid]
  )

  // Dashboard tabs and widgets
  const dashboardTabs = useMemo(
    () => tabs.filter(tab => tab.dashboardId === dashboard.id),
    [tabs, dashboard.id]
  )
  const allDashboardWidgets = useMemo(() => {
    const tabIds = new Set(dashboardTabs.map(tab => tab.id))
    return widgets.filter(w => tabIds.has(w.tabId))
  }, [widgets, dashboardTabs])

  const currentTabWidgets = useMemo(
    () => currentTabId ? widgets.filter(w => w.tabId === currentTabId) : [],
    [widgets, currentTabId]
  )

  // Reset local state when dialog opens
  useEffect(() => {
    if (open) {
      setShowWidgetTitles(dashboard.showWidgetTitles ?? true)
      setDefaultDatasetFileId(dashboard.defaultDatasetFileId ?? null)
    }
  }, [open, dashboard.showWidgetTitles, dashboard.defaultDatasetFileId])

  const handleSave = () => {
    updateDashboard(dashboard.id, {
      showWidgetTitles,
      defaultDatasetFileId,
    })
    onOpenChange(false)
  }

  const handleBulkAssign = () => {
    if (!bulkAssignScope || !defaultDatasetFileId) return
    const targetWidgets = bulkAssignScope === 'all' ? allDashboardWidgets : currentTabWidgets
    for (const w of targetWidgets) {
      updateWidgetDataset(w.id, defaultDatasetFileId)
    }
    setBulkAssignScope(null)
  }

  const bulkCount = bulkAssignScope === 'all' ? allDashboardWidgets.length : currentTabWidgets.length
  const currentTabName = currentTabId ? dashboardTabs.find(tab => tab.id === currentTabId)?.name ?? '' : ''

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dashboard.settings_title')}</DialogTitle>
          <DialogDescription>{t('dashboard.settings_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Widget title bars toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-xs font-medium">{t('dashboard.show_widget_titles')}</Label>
              <p className="text-[11px] text-muted-foreground">{t('dashboard.show_widget_titles_hint')}</p>
            </div>
            <Switch checked={showWidgetTitles} onCheckedChange={setShowWidgetTitles} />
          </div>

          {/* Default dataset */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t('dashboard.default_dataset')}</Label>
            <p className="text-[11px] text-muted-foreground">{t('dashboard.default_dataset_hint')}</p>
            <Select
              value={defaultDatasetFileId ?? '__none__'}
              onValueChange={v => setDefaultDatasetFileId(v === '__none__' ? null : v)}
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder={t('dashboard.widget_dataset_placeholder')} />
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={4}>
                <SelectItem value="__none__">{t('dashboard.widget_dataset_none')}</SelectItem>
                {projectDatasetFiles.map(f => (
                  <SelectItem key={f.id} value={f.id}>
                    <div className="flex items-center gap-2">
                      <Database size={12} className="text-muted-foreground" />
                      {f.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Bulk-assign dataset */}
          {defaultDatasetFileId && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t('dashboard.assign_dataset')}</Label>
              <p className="text-[11px] text-muted-foreground">{t('dashboard.assign_dataset_hint')}</p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setBulkAssignScope('tab')}
                  disabled={currentTabWidgets.length === 0}
                >
                  {t('dashboard.assign_current_tab')} ({currentTabWidgets.length})
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setBulkAssignScope('all')}
                  disabled={allDashboardWidgets.length === 0}
                >
                  {t('dashboard.assign_all_tabs')} ({allDashboardWidgets.length})
                </Button>
              </div>
            </div>
          )}
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

    <AlertDialog open={bulkAssignScope !== null} onOpenChange={v => { if (!v) setBulkAssignScope(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('dashboard.assign_confirm_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {bulkAssignScope === 'all'
              ? t('dashboard.assign_confirm_all', { count: bulkCount, dataset: projectDatasetFiles.find(f => f.id === defaultDatasetFileId)?.name ?? '' })
              : t('dashboard.assign_confirm_tab', { count: bulkCount, tab: currentTabName, dataset: projectDatasetFiles.find(f => f.id === defaultDatasetFileId)?.name ?? '' })
            }
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={handleBulkAssign}>
            {t('common.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
