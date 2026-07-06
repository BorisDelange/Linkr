import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Info } from 'lucide-react'
import { useSaveForm } from '@/hooks/use-save-form'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { measureFitRows } from './dashboard-grid'

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
  const { updateDashboard, widgets, tabs, updateWidgetDataset, fitDashboardToHeight } = useDashboardStore()
  const { files: datasetFiles } = useDatasetStore()

  const [showWidgetTitles, setShowWidgetTitles] = useState(dashboard.showWidgetTitles ?? true)
  const [defaultDatasetFileId, setDefaultDatasetFileId] = useState<string | null>(dashboard.defaultDatasetFileId ?? null)
  const [widgetSpacing, setWidgetSpacing] = useState<number>(dashboard.widgetSpacing ?? 12)
  const [reloadWidgetsOnTabSwitch, setReloadWidgetsOnTabSwitch] = useState(dashboard.reloadWidgetsOnTabSwitch ?? false)
  const [fitToHeight, setFitToHeight] = useState(dashboard.fitToHeight !== false)

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
      setWidgetSpacing(dashboard.widgetSpacing ?? 12)
      setReloadWidgetsOnTabSwitch(dashboard.reloadWidgetsOnTabSwitch ?? false)
      setFitToHeight(dashboard.fitToHeight !== false)
    }
  }, [open, dashboard.showWidgetTitles, dashboard.defaultDatasetFileId, dashboard.widgetSpacing, dashboard.reloadWidgetsOnTabSwitch, dashboard.fitToHeight])

  const handleSave = () => {
    updateDashboard(dashboard.id, {
      showWidgetTitles,
      defaultDatasetFileId,
      widgetSpacing,
      reloadWidgetsOnTabSwitch,
      fitToHeight,
    })
    // Turning "fit to height" on: only trim layouts that overflow the visible area — keep the
    // widgets' heights otherwise (no re-stretching to fill). Measure the live grid viewport (behind
    // this dialog) for the row count.
    const turnedOn = fitToHeight && dashboard.fitToHeight === false
    if (turnedOn) {
      const rows = measureFitRows()
      if (rows) fitDashboardToHeight(dashboard.id, rows, 'shrink-only')
    }
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

  const settings = useSaveForm({
    current: { showWidgetTitles, defaultDatasetFileId, widgetSpacing, reloadWidgetsOnTabSwitch, fitToHeight },
    baseline: {
      showWidgetTitles: dashboard.showWidgetTitles ?? true,
      defaultDatasetFileId: dashboard.defaultDatasetFileId ?? null,
      widgetSpacing: dashboard.widgetSpacing ?? 12,
      reloadWidgetsOnTabSwitch: dashboard.reloadWidgetsOnTabSwitch ?? false,
      fitToHeight: dashboard.fitToHeight !== false,
    },
    onSave: handleSave,
  })

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dashboard.settings_title')}</DialogTitle>
          <DialogDescription>{t('dashboard.settings_description')}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general" className="py-2">
          <TabsList className="w-full">
            <TabsTrigger value="general" className="flex-1">{t('dashboard.settings_tab_general', 'General')}</TabsTrigger>
            <TabsTrigger value="style" className="flex-1">{t('dashboard.settings_tab_style', 'Style')}</TabsTrigger>
            <TabsTrigger value="dataset" className="flex-1">{t('dashboard.settings_tab_dataset', 'Dataset')}</TabsTrigger>
          </TabsList>

          <div className="min-h-[210px]">
          <TabsContent value="general" className="space-y-5 pt-3">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1">
                <Label className="text-xs font-medium">{t('dashboard.reload_widgets_on_tab_switch')}</Label>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-muted-foreground/70 hover:text-muted-foreground">
                        <Info size={12} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64 bg-foreground text-background">
                      {t('dashboard.reload_widgets_on_tab_switch_info')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <p className="text-[11px] text-muted-foreground">{t('dashboard.reload_widgets_on_tab_switch_hint')}</p>
            </div>
            <Switch checked={reloadWidgetsOnTabSwitch} onCheckedChange={setReloadWidgetsOnTabSwitch} />
          </div>
          </TabsContent>

          <TabsContent value="style" className="space-y-5 pt-3">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label className="text-xs font-medium">{t('dashboard.show_widget_titles')}</Label>
              <p className="text-[11px] text-muted-foreground">{t('dashboard.show_widget_titles_hint')}</p>
            </div>
            <Switch checked={showWidgetTitles} onCheckedChange={setShowWidgetTitles} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label className="text-xs font-medium">{t('dashboard.fit_to_height')}</Label>
              <p className="text-[11px] text-muted-foreground">{t('dashboard.fit_to_height_hint')}</p>
            </div>
            <Switch checked={fitToHeight} onCheckedChange={setFitToHeight} />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">{t('dashboard.widget_spacing', 'Widget spacing')}</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">{widgetSpacing} px</span>
            </div>
            <p className="text-[11px] text-muted-foreground">{t('dashboard.widget_spacing_hint', 'Gap between widgets on the grid.')}</p>
            <input
              type="range"
              min={0}
              max={32}
              step={2}
              value={widgetSpacing}
              onChange={(e) => setWidgetSpacing(Number(e.target.value))}
              className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            />
          </div>
          </TabsContent>

          <TabsContent value="dataset" className="space-y-5 pt-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t('dashboard.default_dataset')}</Label>
            <p className="text-[11px] text-muted-foreground">{t('dashboard.default_dataset_hint')}</p>
            <Select
              value={defaultDatasetFileId ?? '__none__'}
              onValueChange={v => setDefaultDatasetFileId(v === '__none__' ? null : v)}
            >
              <SelectTrigger className="mt-1 h-8 text-sm">
                <SelectValue placeholder={t('dashboard.widget_dataset_placeholder')} />
              </SelectTrigger>
              <SelectContent position="popper" side="top" sideOffset={4}>
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
          </TabsContent>
          </div>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={settings.save} disabled={!settings.canSaveNow}>
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
