import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Info } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { useSaveForm } from '@/hooks/use-save-form'
import { DASHBOARD_GRID } from '@/features/projects/dashboard/dashboard-grid'

interface PatientDataSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  dashboardId: string
}

/** Board settings, mirroring the dashboard's own dialog: General holds the
 *  tab-switch behaviour, Style the display options. Name and description are
 *  edited from the board's header menu, and there is no Dataset tab — a patient
 *  board reads the project's OMOP source, it does not bind to a dataset. */
export function PatientDataSettingsDialog({
  open,
  onOpenChange,
  dashboardId,
}: PatientDataSettingsDialogProps) {
  const { t } = useTranslation()
  const board = usePatientChartStore((s) => s.dashboards.find((d) => d.id === dashboardId))
  const updateDashboard = usePatientChartStore((s) => s.updateDashboard)

  const baseline = {
    reloadWidgetsOnTabSwitch: board?.reloadWidgetsOnTabSwitch ?? false,
    showWidgetTitles: board?.showWidgetTitles ?? true,
    fitToHeight: board?.fitToHeight ?? true,
    widgetSpacing: board?.widgetSpacing ?? DASHBOARD_GRID.margin[0],
  }

  const [draft, setDraft] = useState(baseline)

  useEffect(() => {
    if (open) setDraft(baseline)
    // Re-seeding on every baseline identity would wipe the user's edits mid-dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dashboardId])

  const handleSave = () => {
    if (!board) return
    updateDashboard(dashboardId, {
      reloadWidgetsOnTabSwitch: draft.reloadWidgetsOnTabSwitch,
      showWidgetTitles: draft.showWidgetTitles,
      fitToHeight: draft.fitToHeight,
      widgetSpacing: draft.widgetSpacing,
    })
    onOpenChange(false)
  }

  const { canSaveNow, save } = useSaveForm({
    current: draft,
    baseline,
    onSave: handleSave,
  })

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t('patient_data.settings_title')}
      description={t('patient_data.settings_description')}
      onConfirm={save}
      confirmLabel={t('common.save')}
      confirmDisabled={!canSaveNow}
      contentClassName="space-y-0"
    >
        <Tabs defaultValue="general" className="py-2">
          <TabsList className="w-full">
            <TabsTrigger value="general" className="flex-1">
              {t('dashboard.settings_tab_general')}
            </TabsTrigger>
            <TabsTrigger value="style" className="flex-1">
              {t('dashboard.settings_tab_style')}
            </TabsTrigger>
          </TabsList>

          <div className="min-h-[210px]">
          <TabsContent value="general" className="space-y-5 pt-3">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1">
                <Label>
                  {t('dashboard.reload_widgets_on_tab_switch')}
                </Label>
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
              <p className="text-[11px] text-muted-foreground">
                {t('dashboard.reload_widgets_on_tab_switch_hint')}
              </p>
            </div>
            <Switch
              checked={draft.reloadWidgetsOnTabSwitch}
              onCheckedChange={(v) =>
                setDraft((d) => ({ ...d, reloadWidgetsOnTabSwitch: v }))
              }
            />
          </div>
          </TabsContent>

          <TabsContent value="style" className="space-y-5 pt-3">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t('dashboard.show_widget_titles')}</Label>
              <p className="text-[11px] text-muted-foreground">
                {t('dashboard.show_widget_titles_hint')}
              </p>
            </div>
            <Switch
              checked={draft.showWidgetTitles}
              onCheckedChange={(v) => setDraft((d) => ({ ...d, showWidgetTitles: v }))}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t('dashboard.fit_to_height')}</Label>
              <p className="text-[11px] text-muted-foreground">{t('dashboard.fit_to_height_hint')}</p>
            </div>
            <Switch
              checked={draft.fitToHeight}
              onCheckedChange={(v) => setDraft((d) => ({ ...d, fitToHeight: v }))}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>{t('dashboard.widget_spacing')}</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {draft.widgetSpacing} px
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">{t('dashboard.widget_spacing_hint')}</p>
            <input
              type="range"
              min={0}
              max={32}
              step={2}
              value={draft.widgetSpacing}
              onChange={(e) => setDraft((d) => ({ ...d, widgetSpacing: Number(e.target.value) }))}
              className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            />
          </div>
          </TabsContent>
          </div>
        </Tabs>
    </DialogShell>
  )
}
