import { useState, useMemo, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Code2, ArrowLeft, Database } from 'lucide-react'
import type { DashboardWidgetSource } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { getLabPlugins } from '@/lib/plugins/registry'
import type { Plugin } from '@/types/plugin'
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const LAST_DATASET_KEY = 'linkr-add-widget-last-dataset'

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

  // Restore last-used dataset for this project
  const [datasetFileId, setDatasetFileId] = useState<string | null>(null)

  const projectDatasetFiles = datasetFiles.filter(
    (f) => f.projectUid === projectUid && f.type === 'file' && f.columns && f.columns.length > 0
  )

  // When dialog opens, restore last-used dataset (if it still exists)
  useEffect(() => {
    if (open) {
      try {
        const stored = localStorage.getItem(LAST_DATASET_KEY)
        if (stored) {
          const map = JSON.parse(stored) as Record<string, string>
          const lastId = map[projectUid]
          if (lastId && projectDatasetFiles.some(f => f.id === lastId)) {
            setDatasetFileId(lastId)
            return
          }
        }
      } catch { /* ignore */ }
      setDatasetFileId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Persist dataset choice to localStorage
  const handleSetDatasetFileId = useCallback((id: string | null) => {
    setDatasetFileId(id)
    try {
      const stored = localStorage.getItem(LAST_DATASET_KEY)
      const map = stored ? (JSON.parse(stored) as Record<string, string>) : {}
      if (id) {
        map[projectUid] = id
      } else {
        delete map[projectUid]
      }
      localStorage.setItem(LAST_DATASET_KEY, JSON.stringify(map))
    } catch { /* ignore */ }
  }, [projectUid])

  const selectedDatasetFile = datasetFiles.find((f) => f.id === datasetFileId)
  const columns = selectedDatasetFile?.columns ?? []

  const plugins = useMemo(() => getLabPlugins(), [])
  const [selectedPluginId, setSelectedPluginId] = useState('')

  // Plugin config step
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null)
  const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>({})
  const [pluginLanguage, setPluginLanguage] = useState<'python' | 'r'>('python')

  // Confirmation dialog for adding widget without dataset
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)

  const resetAndClose = () => {
    setConfigPlugin(null)
    setPluginConfig({})
    setPluginLanguage('python')
    setSelectedPluginId('')
    setPendingAction(null)
    onOpenChange(false)
  }

  const doSelectPlugin = (plugin: Plugin) => {
    setSelectedPluginId(plugin.manifest.id)
    const hasConfig = plugin.manifest.configSchema && Object.keys(plugin.manifest.configSchema).length > 0
    const hasBothLangs = !!(plugin.templates?.python && plugin.templates?.r)

    // Default language for this plugin
    const defaultLang: 'python' | 'r' = plugin.templates?.python ? 'python' : 'r'

    if (hasConfig || hasBothLangs) {
      setConfigPlugin(plugin)
      setPluginConfig({})
      setPluginLanguage(defaultLang)
    } else {
      // No config needed, add immediately
      const name = plugin.manifest.name[lang] ?? plugin.manifest.name.en ?? plugin.manifest.id
      const source: DashboardWidgetSource = {
        type: 'plugin',
        pluginId: plugin.manifest.id,
        language: defaultLang,
        config: {},
      }
      addWidget(tabId, source, name, datasetFileId)
      resetAndClose()
    }
  }

  const handleSelectPlugin = (plugin: Plugin) => {
    if (!datasetFileId) {
      setPendingAction(() => () => doSelectPlugin(plugin))
    } else {
      doSelectPlugin(plugin)
    }
  }

  const handleConfirmPlugin = () => {
    if (!configPlugin) return
    const name = configPlugin.manifest.name[lang] ?? configPlugin.manifest.name.en ?? configPlugin.manifest.id
    const source: DashboardWidgetSource = {
      type: 'plugin',
      pluginId: configPlugin.manifest.id,
      language: pluginLanguage,
      config: { ...pluginConfig },
    }
    addWidget(tabId, source, name, datasetFileId)
    resetAndClose()
  }

  const doAddInline = (language: 'python' | 'r' | 'sql') => {
    const source: DashboardWidgetSource = {
      type: 'inline',
      language,
      code: `# ${language} code here\n`,
      config: {},
    }
    addWidget(tabId, source, `Custom ${language}`, datasetFileId)
    resetAndClose()
  }

  const handleAddInline = (language: 'python' | 'r' | 'sql') => {
    if (!datasetFileId) {
      setPendingAction(() => () => doAddInline(language))
    } else {
      doAddInline(language)
    }
  }

  // Dataset selector shared between views
  const datasetSelector = (
    <div className="space-y-1">
      <Label className="text-xs">{t('dashboard.widget_dataset')}</Label>
      <Select
        value={datasetFileId ?? '__none__'}
        onValueChange={(v) => handleSetDatasetFileId(v === '__none__' ? null : v)}
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
    const configHasBothLangs = !!(configPlugin.templates?.python && configPlugin.templates?.r)
    const hasConfigSchema = configPlugin.manifest.configSchema && Object.keys(configPlugin.manifest.configSchema).length > 0
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

          <div className="space-y-4">
            {configHasBothLangs && (
              <div className="space-y-1">
                <Label className="text-xs">{t('common.language')}</Label>
                <Select value={pluginLanguage} onValueChange={(v) => setPluginLanguage(v as 'python' | 'r')}>
                  <SelectTrigger className="h-8 w-40 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" sideOffset={4}>
                    <SelectItem value="python">Python</SelectItem>
                    <SelectItem value="r">R</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {hasConfigSchema && (
              <div className="max-h-80 overflow-y-auto">
                <GenericConfigPanel
                  schema={configPlugin.manifest.configSchema!}
                  config={pluginConfig}
                  columns={columns}
                  onConfigChange={(changes) => setPluginConfig((prev) => ({ ...prev, ...changes }))}
                />
              </div>
            )}
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
    <>
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

    <AlertDialog open={!!pendingAction} onOpenChange={(v) => { if (!v) setPendingAction(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('dashboard.no_dataset_confirm_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('dashboard.no_dataset_confirm_description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => { pendingAction?.(); setPendingAction(null) }}>
            {t('common.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    </>
  )
}
