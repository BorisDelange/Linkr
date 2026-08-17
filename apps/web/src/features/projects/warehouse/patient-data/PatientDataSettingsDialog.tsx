import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { useSaveForm } from '@/hooks/use-save-form'
import { localized, setLocalized } from '@/lib/localized'
import { DASHBOARD_GRID } from '@/features/projects/dashboard/dashboard-grid'

interface PatientDataSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  dashboardId: string
}

/** Board settings, on the same General/Style split as the dashboard's own
 *  settings dialog. There is no Dataset tab: a patient board reads the project's
 *  OMOP source, it does not bind to a dataset. */
export function PatientDataSettingsDialog({
  open,
  onOpenChange,
  dashboardId,
}: PatientDataSettingsDialogProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const board = usePatientChartStore((s) => s.dashboards.find((d) => d.id === dashboardId))
  const updateDashboard = usePatientChartStore((s) => s.updateDashboard)

  const baseline = {
    name: localized(board?.name ?? {}, lang),
    description: localized(board?.description ?? {}, lang),
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
      name: setLocalized(board.name, lang, draft.name),
      description: setLocalized(board.description ?? {}, lang, draft.description),
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('patient_data.settings_title')}</DialogTitle>
          <DialogDescription>{t('patient_data.settings_description')}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general">
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
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('common.name')}</Label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('common.description')}</Label>
                <Textarea
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  rows={3}
                  className="resize-none text-xs"
                />
              </div>
            </TabsContent>

            <TabsContent value="style" className="space-y-5 pt-3">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium">
                    {t('dashboard.show_widget_titles')}
                  </Label>
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
                  <Label className="text-xs font-medium">{t('dashboard.fit_to_height')}</Label>
                  <p className="text-[11px] text-muted-foreground">
                    {t('dashboard.fit_to_height_hint')}
                  </p>
                </div>
                <Switch
                  checked={draft.fitToHeight}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, fitToHeight: v }))}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">{t('dashboard.widget_spacing')}</Label>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {draft.widgetSpacing} px
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t('dashboard.widget_spacing_hint')}
                </p>
                <input
                  type="range"
                  min={0}
                  max={32}
                  step={2}
                  value={draft.widgetSpacing}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, widgetSpacing: Number(e.target.value) }))
                  }
                  className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                />
              </div>
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={save} disabled={!canSaveNow}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
