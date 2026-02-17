import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Users, TrendingUp, Heart, TableIcon, Hash, BarChart3, Code2, ArrowLeft } from 'lucide-react'
import type { DashboardWidgetSource } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDashboardData } from './DashboardDataProvider'
import { getAllAnalysisPlugins } from '@/lib/analysis-plugins/registry'
import type { AnalysisPlugin } from '@/types/analysis-plugin'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  const { t, i18n } = useTranslation()
  const { addWidget } = useDashboardStore()
  const { columns } = useDashboardData()
  const [activeTab, setActiveTab] = useState('builtin')
  const lang = i18n.language as 'en' | 'fr'

  // Plugin config step
  const [selectedPlugin, setSelectedPlugin] = useState<AnalysisPlugin | null>(null)
  const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>({})

  const plugins = getAllAnalysisPlugins()

  const resetAndClose = () => {
    setSelectedPlugin(null)
    setPluginConfig({})
    onOpenChange(false)
  }

  const handleAddBuiltin = (opt: BuiltinOption) => {
    const source: DashboardWidgetSource = {
      type: 'builtin',
      builtinType: opt.builtinType,
      config: { ...opt.defaultConfig },
    }
    addWidget(tabId, source, t(opt.nameKey))
    resetAndClose()
  }

  const handleSelectPlugin = (plugin: AnalysisPlugin) => {
    const hasConfig = plugin.manifest.configSchema && Object.keys(plugin.manifest.configSchema).length > 0

    if (hasConfig) {
      setSelectedPlugin(plugin)
      setPluginConfig({})
    } else {
      // No config needed, add immediately
      const name = plugin.manifest.name[lang] ?? plugin.manifest.name.en ?? plugin.manifest.id
      const source: DashboardWidgetSource = {
        type: 'plugin',
        pluginId: plugin.manifest.id,
        config: {},
      }
      addWidget(tabId, source, name)
      resetAndClose()
    }
  }

  const handleConfirmPlugin = () => {
    if (!selectedPlugin) return
    const name = selectedPlugin.manifest.name[lang] ?? selectedPlugin.manifest.name.en ?? selectedPlugin.manifest.id
    const source: DashboardWidgetSource = {
      type: 'plugin',
      pluginId: selectedPlugin.manifest.id,
      config: { ...pluginConfig },
    }
    addWidget(tabId, source, name)
    resetAndClose()
  }

  const handleAddInline = (language: 'python' | 'r' | 'sql') => {
    const source: DashboardWidgetSource = {
      type: 'inline',
      language,
      code: `# ${language} code here\n`,
      config: {},
    }
    addWidget(tabId, source, `Custom ${language}`)
    resetAndClose()
  }

  // Plugin config step view
  if (selectedPlugin) {
    const pluginName = selectedPlugin.manifest.name[lang] ?? selectedPlugin.manifest.name.en ?? selectedPlugin.manifest.id
    return (
      <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose() }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setSelectedPlugin(null)}
              >
                <ArrowLeft size={14} />
              </Button>
              {pluginName}
            </DialogTitle>
            <DialogDescription>
              {t('dashboard.plugin_configure_description')}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-80 overflow-y-auto">
            <GenericConfigPanel
              schema={selectedPlugin.manifest.configSchema!}
              config={pluginConfig}
              columns={columns}
              onConfigChange={(changes) => setPluginConfig((prev) => ({ ...prev, ...changes }))}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSelectedPlugin(null)}>
              {t('common.back')}
            </Button>
            <Button size="sm" onClick={handleConfirmPlugin}>
              {t('dashboard.add_widget')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose() }}>
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
                  {t('dashboard.plugin_no_plugins')}
                </p>
              ) : (
                plugins.map((plugin) => {
                  const name = plugin.manifest.name[lang] ?? plugin.manifest.name.en ?? plugin.manifest.id
                  const desc = plugin.manifest.description[lang] ?? plugin.manifest.description.en ?? ''
                  const hasConfig = plugin.manifest.configSchema && Object.keys(plugin.manifest.configSchema).length > 0
                  return (
                    <button
                      key={plugin.manifest.id}
                      onClick={() => handleSelectPlugin(plugin)}
                      className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <BarChart3 size={20} className="text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{name}</p>
                        {desc && (
                          <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                        )}
                      </div>
                      {hasConfig && (
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {t('dashboard.widget_configure')}...
                        </span>
                      )}
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
