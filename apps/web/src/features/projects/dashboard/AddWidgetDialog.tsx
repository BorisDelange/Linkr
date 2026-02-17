import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Users, TrendingUp, Heart, TableIcon, Hash, BarChart3, Code2 } from 'lucide-react'
import type { DashboardWidgetSource } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { getAllAnalysisPlugins } from '@/lib/analysis-plugins/registry'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

interface AddWidgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tabId: string
}

interface BuiltinOption {
  builtinType: string
  nameKey: string
  descriptionKey: string
  icon: React.ReactNode
  defaultConfig: Record<string, unknown>
}

const builtinOptions: BuiltinOption[] = [
  // Legacy demo widgets
  {
    builtinType: 'admission_count',
    nameKey: 'dashboard.widget_admission_count',
    descriptionKey: 'dashboard.widget_admission_count_desc',
    icon: <Activity size={20} className="text-blue-500" />,
    defaultConfig: {},
  },
  {
    builtinType: 'patient_count',
    nameKey: 'dashboard.widget_patient_count',
    descriptionKey: 'dashboard.widget_patient_count_desc',
    icon: <Users size={20} className="text-violet-500" />,
    defaultConfig: {},
  },
  {
    builtinType: 'admission_timeline',
    nameKey: 'dashboard.widget_admission_timeline',
    descriptionKey: 'dashboard.widget_admission_timeline_desc',
    icon: <TrendingUp size={20} className="text-emerald-500" />,
    defaultConfig: {},
  },
  {
    builtinType: 'heart_rate',
    nameKey: 'dashboard.widget_heart_rate',
    descriptionKey: 'dashboard.widget_heart_rate_desc',
    icon: <Heart size={20} className="text-red-500" />,
    defaultConfig: {},
  },
  {
    builtinType: 'vitals_table',
    nameKey: 'dashboard.widget_vitals_table',
    descriptionKey: 'dashboard.widget_vitals_table_desc',
    icon: <TableIcon size={20} className="text-orange-500" />,
    defaultConfig: {},
  },
  // Data-aware builtins
  {
    builtinType: 'kpi',
    nameKey: 'dashboard.builtin_kpi',
    descriptionKey: 'dashboard.builtin_kpi_desc',
    icon: <Hash size={20} className="text-teal-500" />,
    defaultConfig: { aggregation: 'count' },
  },
  {
    builtinType: 'table',
    nameKey: 'dashboard.builtin_table',
    descriptionKey: 'dashboard.builtin_table_desc',
    icon: <TableIcon size={20} className="text-blue-500" />,
    defaultConfig: { maxRows: 50 },
  },
  {
    builtinType: 'chart',
    nameKey: 'dashboard.builtin_chart',
    descriptionKey: 'dashboard.builtin_chart_desc',
    icon: <BarChart3 size={20} className="text-purple-500" />,
    defaultConfig: { chartType: 'bar' },
  },
]

export function AddWidgetDialog({ open, onOpenChange, tabId }: AddWidgetDialogProps) {
  const { t } = useTranslation()
  const { addWidget } = useDashboardStore()
  const [activeTab, setActiveTab] = useState('builtin')

  const plugins = getAllAnalysisPlugins()

  const handleAddBuiltin = (opt: BuiltinOption) => {
    const source: DashboardWidgetSource = {
      type: 'builtin',
      builtinType: opt.builtinType,
      config: { ...opt.defaultConfig },
    }
    addWidget(tabId, source, t(opt.nameKey))
    onOpenChange(false)
  }

  const handleAddPlugin = (pluginId: string, pluginName: string) => {
    const source: DashboardWidgetSource = {
      type: 'plugin',
      pluginId,
      config: {},
    }
    addWidget(tabId, source, pluginName)
    onOpenChange(false)
  }

  const handleAddInline = (language: 'python' | 'r' | 'sql') => {
    const source: DashboardWidgetSource = {
      type: 'inline',
      language,
      code: `# ${language} code here\n`,
      config: {},
    }
    addWidget(tabId, source, `Custom ${language}`)
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

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-2">
          <TabsList className="w-full">
            <TabsTrigger value="builtin" className="flex-1 text-xs">
              {t('dashboard.source_builtin')}
            </TabsTrigger>
            <TabsTrigger value="plugin" className="flex-1 text-xs">
              {t('dashboard.source_plugin')}
            </TabsTrigger>
            <TabsTrigger value="inline" className="flex-1 text-xs">
              {t('dashboard.source_inline')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="builtin" className="mt-3">
            <div className="grid gap-2 max-h-80 overflow-y-auto">
              {builtinOptions.map((opt) => (
                <button
                  key={opt.builtinType}
                  onClick={() => handleAddBuiltin(opt)}
                  className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    {opt.icon}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t(opt.nameKey)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t(opt.descriptionKey)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="plugin" className="mt-3">
            <div className="grid gap-2 max-h-80 overflow-y-auto">
              {plugins.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  No analysis plugins available
                </p>
              ) : (
                plugins.map((plugin) => {
                  const name = typeof plugin.manifest.name === 'object'
                    ? (plugin.manifest.name as Record<string, string>).en ?? plugin.manifest.id
                    : plugin.manifest.id
                  const desc = typeof plugin.manifest.description === 'object'
                    ? (plugin.manifest.description as Record<string, string>).en ?? ''
                    : ''
                  return (
                    <button
                      key={plugin.manifest.id}
                      onClick={() => handleAddPlugin(plugin.manifest.id, name)}
                      className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <BarChart3 size={20} className="text-primary" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{name}</p>
                        {desc && (
                          <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                        )}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </TabsContent>

          <TabsContent value="inline" className="mt-3">
            <div className="grid gap-2">
              {(['python', 'r', 'sql'] as const).map((lang) => (
                <button
                  key={lang}
                  onClick={() => handleAddInline(lang)}
                  className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Code2 size={20} className="text-amber-500" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{lang.toUpperCase()}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Write custom {lang} code for this widget
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
