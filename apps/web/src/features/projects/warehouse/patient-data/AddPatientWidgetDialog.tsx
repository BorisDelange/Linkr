import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import * as LucideIcons from 'lucide-react'
import {
  usePatientChartStore,
  type PatientWidgetType,
  type PluginWidgetConfig,
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
  FileText,
  Puzzle,
} from 'lucide-react'
import { getWarehousePlugins } from '@/lib/analysis-plugins/registry'
import { SYSTEM_PLUGIN_IDS } from '@/lib/analysis-plugins/builtin-widget-plugins'
import { cn } from '@/lib/utils'

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
  {
    type: 'notes',
    nameKey: 'patient_data.widget_notes',
    descriptionKey: 'patient_data.widget_notes_desc',
    icon: <FileText size={20} className="text-cyan-500" />,
  },
]

const ICON_COLOR_CLASS: Record<string, string> = {
  red: 'text-red-500', blue: 'text-blue-500', green: 'text-green-500',
  violet: 'text-violet-500', amber: 'text-amber-500', rose: 'text-rose-500',
  cyan: 'text-cyan-500', slate: 'text-slate-500',
}

function getPluginIcon(iconName: string): LucideIcons.LucideIcon {
  const icon = (LucideIcons as Record<string, unknown>)[iconName]
  if (typeof icon === 'object' && icon !== null) return icon as LucideIcons.LucideIcon
  return Puzzle
}

export function AddPatientWidgetDialog({
  open,
  onOpenChange,
  tabId,
}: AddPatientWidgetDialogProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const { addWidget } = usePatientChartStore()

  // Custom warehouse plugins (exclude system plugins which are shown as built-in buttons)
  const customWarehousePlugins = useMemo(
    () => getWarehousePlugins().filter(p => !SYSTEM_PLUGIN_IDS.has(p.manifest.id)),
    [],
  )

  const handleAdd = (wt: WidgetTypeOption) => {
    addWidget(tabId, wt.type, t(wt.nameKey))
    onOpenChange(false)
  }

  const handleAddPlugin = (plugin: ReturnType<typeof getWarehousePlugins>[0]) => {
    const name = plugin.manifest.name?.[lang] ?? plugin.manifest.name?.en ?? plugin.manifest.id
    const config: PluginWidgetConfig = {
      pluginId: plugin.manifest.id,
      language: plugin.manifest.languages[0] ?? 'python',
      pluginConfig: {},
    }
    addWidget(tabId, 'plugin', name, config)
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

          {/* Custom warehouse plugins */}
          {customWarehousePlugins.length > 0 && (
            <>
              <div className="mt-2 mb-1">
                <p className="text-xs font-medium text-muted-foreground">{t('patient_data.plugin_widgets')}</p>
              </div>
              {customWarehousePlugins.map((plugin) => {
                const m = plugin.manifest
                const Icon = getPluginIcon(m.icon)
                const colorClass = m.iconColor ? ICON_COLOR_CLASS[m.iconColor] : 'text-muted-foreground'
                return (
                  <button
                    key={m.id}
                    onClick={() => handleAddPlugin(plugin)}
                    className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Icon size={20} className={cn(colorClass)} style={!ICON_COLOR_CLASS[m.iconColor ?? ''] && m.iconColor ? { color: m.iconColor } : undefined} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{m.name?.[lang] ?? m.name?.en ?? m.id}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {m.description?.[lang] ?? m.description?.en ?? ''}
                      </p>
                    </div>
                  </button>
                )
              })}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
