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
import type { Dashboard } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'

interface DashboardSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  dashboard: Dashboard
}

export function DashboardSettingsDialog({
  open,
  onOpenChange,
  dashboard,
}: DashboardSettingsDialogProps) {
  const { t } = useTranslation()
  const { updateDashboard } = useDashboardStore()

  const [showWidgetTitles, setShowWidgetTitles] = useState(dashboard.showWidgetTitles ?? true)

  // Reset local state when dialog opens
  useEffect(() => {
    if (open) {
      setShowWidgetTitles(dashboard.showWidgetTitles ?? true)
    }
  }, [open, dashboard.showWidgetTitles])

  const handleSave = () => {
    updateDashboard(dashboard.id, { showWidgetTitles })
    onOpenChange(false)
  }

  return (
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
