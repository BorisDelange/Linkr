import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
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
import { usePatientChartStore } from '@/stores/patient-chart-store'

interface PatientDataSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectUid: string
}

export function PatientDataSettingsDialog({
  open,
  onOpenChange,
  projectUid,
}: PatientDataSettingsDialogProps) {
  const { t } = useTranslation()
  const { showWidgetTitles, setShowWidgetTitles, allowWidgetScroll, setAllowWidgetScroll } = usePatientChartStore()

  const [localShowTitles, setLocalShowTitles] = useState(showWidgetTitles[projectUid] ?? true)
  const [localAllowScroll, setLocalAllowScroll] = useState(allowWidgetScroll[projectUid] ?? true)

  useEffect(() => {
    if (open) {
      setLocalShowTitles(showWidgetTitles[projectUid] ?? true)
      setLocalAllowScroll(allowWidgetScroll[projectUid] ?? true)
    }
  }, [open, showWidgetTitles, allowWidgetScroll, projectUid])

  const handleSave = () => {
    setShowWidgetTitles(projectUid, localShowTitles)
    setAllowWidgetScroll(projectUid, localAllowScroll)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('patient_data.settings_title')}</DialogTitle>
          <DialogDescription>{t('patient_data.settings_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-xs font-medium">{t('dashboard.show_widget_titles')}</Label>
              <p className="text-[11px] text-muted-foreground">{t('dashboard.show_widget_titles_hint')}</p>
            </div>
            <Switch checked={localShowTitles} onCheckedChange={setLocalShowTitles} />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-xs font-medium">{t('patient_data.allow_scroll')}</Label>
              <p className="text-[11px] text-muted-foreground">{t('patient_data.allow_scroll_hint')}</p>
            </div>
            <Switch checked={localAllowScroll} onCheckedChange={setLocalAllowScroll} />
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
