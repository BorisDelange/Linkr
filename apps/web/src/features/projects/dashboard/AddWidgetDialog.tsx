import { useTranslation } from 'react-i18next'
import { useDashboardStore } from '@/stores/dashboard-store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Activity, Users, TrendingUp, Heart, TableIcon } from 'lucide-react'

interface AddWidgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tabId: string
}

interface WidgetType {
  type: string
  nameKey: string
  descriptionKey: string
  icon: React.ReactNode
}

const widgetTypes: WidgetType[] = [
  {
    type: 'admission_count',
    nameKey: 'dashboard.widget_admission_count',
    descriptionKey: 'dashboard.widget_admission_count_desc',
    icon: <Activity size={20} className="text-blue-500" />,
  },
  {
    type: 'patient_count',
    nameKey: 'dashboard.widget_patient_count',
    descriptionKey: 'dashboard.widget_patient_count_desc',
    icon: <Users size={20} className="text-violet-500" />,
  },
  {
    type: 'admission_timeline',
    nameKey: 'dashboard.widget_admission_timeline',
    descriptionKey: 'dashboard.widget_admission_timeline_desc',
    icon: <TrendingUp size={20} className="text-emerald-500" />,
  },
  {
    type: 'heart_rate',
    nameKey: 'dashboard.widget_heart_rate',
    descriptionKey: 'dashboard.widget_heart_rate_desc',
    icon: <Heart size={20} className="text-red-500" />,
  },
  {
    type: 'vitals_table',
    nameKey: 'dashboard.widget_vitals_table',
    descriptionKey: 'dashboard.widget_vitals_table_desc',
    icon: <TableIcon size={20} className="text-orange-500" />,
  },
]

export function AddWidgetDialog({
  open,
  onOpenChange,
  tabId,
}: AddWidgetDialogProps) {
  const { t } = useTranslation()
  const { addWidget } = useDashboardStore()

  const handleAdd = (wt: WidgetType) => {
    addWidget(tabId, wt.type, t(wt.nameKey))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('dashboard.add_widget_title')}</DialogTitle>
          <DialogDescription>
            {t('dashboard.add_widget_description')}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2 grid gap-2">
          {widgetTypes.map((wt) => (
            <button
              key={wt.type}
              onClick={() => handleAdd(wt)}
              className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                {wt.icon}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium">{t(wt.nameKey)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t(wt.descriptionKey)}
                </p>
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
