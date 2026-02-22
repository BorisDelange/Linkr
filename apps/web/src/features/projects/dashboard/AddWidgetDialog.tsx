import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Code2, ArrowLeft, Database } from 'lucide-react'
import type { DashboardWidgetSource } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { getLabPlugins } from '@/lib/analysis-plugins/registry'
import type { AnalysisPlugin } from '@/types/analysis-plugin'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import { PluginPicker } from '@/components/PluginPicker'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
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

interface AddWidgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tabId: string
  projectUid: string
}

export function AddWidgetDialog({ open, onOpenChange, tabId, projectUid }: AddWidgetDialogProps) {
  const { t, i18n } = useTranslation()
  const { addWidget } = useDashboardStore()
  const { files: datasetFiles } = useDatasetStore()
  const [activeTab, setActiveTab] = useState('plugin')
  const lang = i18n.language as 'en' | 'fr'

  const [datasetFileId, setDatasetFileId] = useState<string | null>(null)

  const projectDatasetFiles = datasetFiles.filter(
    (f) => f.projectUid === projectUid && f.type === 'file' && f.columns && f.columns.length > 0
  )

  const selectedDatasetFile = datasetFiles.find((f) => f.id === datasetFileId)
  const columns = selectedDatasetFile?.columns ?? []

  const plugins = useMemo(() => getLabPlugins(), [])
  const [selectedPluginId, setSelectedPluginId] = useState('')

  // Plugin config step
  const [configPlugin, setConfigPlugin] = useState<AnalysisPlugin | null>(null)
  const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>({})

  const resetAndClose = () => {
    setConfigPlugin(null)
    setPluginConfig({})
    setSelectedPluginId('')
    setDatasetFileId(null)
    onOpenChange(false)
  }

  const handleSelectPlugin = (plugin: AnalysisPlugin) => {
    setSelectedPluginId(plugin.manifest.id)
    const hasConfig = plugin.manifest.configSchema && Object.keys(plugin.manifest.configSchema).length > 0

    if (hasConfig) {
      setConfigPlugin(plugin)
      setPluginConfig({})
    } else {
      // No config needed, add immediately
      const name = plugin.manifest.name[lang] ?? plugin.manifest.name.en ?? plugin.manifest.id
      const source: DashboardWidgetSource = {
        type: 'plugin',
        pluginId: plugin.manifest.id,
        config: {},
      }
      addWidget(tabId, source, name, datasetFileId)
      resetAndClose()
    }
  }

  const handleConfirmPlugin = () => {
    if (!configPlugin) return
    const name = configPlugin.manifest.name[lang] ?? configPlugin.manifest.name.en ?? configPlugin.manifest.id
    const source: DashboardWidgetSource = {
      type: 'plugin',
      pluginId: configPlugin.manifest.id,
      config: { ...pluginConfig },
    }
    addWidget(tabId, source, name, datasetFileId)
    resetAndClose()
  }

  const handleAddInline = (language: 'python' | 'r' | 'sql') => {
    const source: DashboardWidgetSource = {
      type: 'inline',
      language,
      code: `# ${language} code here\n`,
      config: {},
    }
    addWidget(tabId, source, `Custom ${language}`, datasetFileId)
    resetAndClose()
  }

  // Dataset selector shared between views
  const datasetSelector = (
    <div className="space-y-1">
      <Label className="text-xs">{t('dashboard.widget_dataset')}</Label>
      <Select
        value={datasetFileId ?? '__none__'}
        onValueChange={(v) => setDatasetFileId(v === '__none__' ? null : v)}
      >
        <SelectTrigger className="h-8 text-sm">
          <SelectValue placeholder={t('dashboard.widget_dataset_placeholder')} />
        </SelectTrigger>
        <SelectContent position="popper" sideOffset={4}>
          <SelectItem value="__none__">{t('dashboard.widget_dataset_none')}</SelectItem>
          {projectDatasetFiles.map((f) => (
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
  )

  // Plugin config step view
  if (configPlugin) {
    const pluginName = configPlugin.manifest.name[lang] ?? configPlugin.manifest.name.en ?? configPlugin.manifest.id
    return (
      <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose() }}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setConfigPlugin(null)}
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
              schema={configPlugin.manifest.configSchema!}
              config={pluginConfig}
              columns={columns}
              onConfigChange={(changes) => setPluginConfig((prev) => ({ ...prev, ...changes }))}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfigPlugin(null)}>
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
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('dashboard.add_widget_title')}</DialogTitle>
          <DialogDescription>
            {t('dashboard.add_widget_description')}
          </DialogDescription>
        </DialogHeader>

        {datasetSelector}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-2">
          <TabsList>
            <TabsTrigger value="plugin" className="text-xs">
              {t('dashboard.source_plugin')}
            </TabsTrigger>
            <TabsTrigger value="inline" className="text-xs">
              {t('dashboard.source_custom_code')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="plugin" className="mt-3">
            <PluginPicker
              plugins={plugins}
              selectedPluginId={selectedPluginId}
              onSelectPlugin={handleSelectPlugin}
              lang={lang}
            />
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
                      {t('dashboard.custom_code_description', { language: lang.toUpperCase() })}
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
