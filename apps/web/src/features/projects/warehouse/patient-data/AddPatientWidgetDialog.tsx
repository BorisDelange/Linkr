import { useTranslation } from 'react-i18next'
import {
  usePatientChartStore,
  type PatientWidgetType,
} from '@/stores/patient-chart-store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  TrendingUp,
  TableIcon,
  User,
  Pill,
  Stethoscope,
} from 'lucide-react'

interface AddPatientWidgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tabId: string
}

interface WidgetTypeOption {
  type: PatientWidgetType
  nameKey: string
  descriptionKey: string
  icon: React.ReactNode
}

const widgetTypes: WidgetTypeOption[] = [
  {
    type: 'patient_summary',
    nameKey: 'patient_data.widget_summary',
    descriptionKey: 'patient_data.widget_summary_desc',
    icon: <User size={20} className="text-violet-500" />,
  },
  {
    type: 'timeline',
    nameKey: 'patient_data.widget_timeline',
    descriptionKey: 'patient_data.widget_timeline_desc',
    icon: <TrendingUp size={20} className="text-blue-500" />,
  },
  {
    type: 'clinical_table',
    nameKey: 'patient_data.widget_clinical_table',
    descriptionKey: 'patient_data.widget_clinical_table_desc',
    icon: <TableIcon size={20} className="text-emerald-500" />,
  },
  {
    type: 'medications',
    nameKey: 'patient_data.widget_medications',
    descriptionKey: 'patient_data.widget_medications_desc',
    icon: <Pill size={20} className="text-orange-500" />,
  },
  {
    type: 'diagnoses',
    nameKey: 'patient_data.widget_diagnoses',
    descriptionKey: 'patient_data.widget_diagnoses_desc',
    icon: <Stethoscope size={20} className="text-red-500" />,
  },
]

export function AddPatientWidgetDialog({
  open,
  onOpenChange,
  tabId,
}: AddPatientWidgetDialogProps) {
  const { t } = useTranslation()
  const { addWidget } = usePatientChartStore()

  const handleAdd = (wt: WidgetTypeOption) => {
    addWidget(tabId, wt.type, t(wt.nameKey))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('patient_data.add_widget_title')}</DialogTitle>
          <DialogDescription>
            {t('patient_data.add_widget_description')}
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
