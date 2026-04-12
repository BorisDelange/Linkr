import { useState, useMemo, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Code2, ArrowLeft, Database, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DashboardWidgetSource } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { getLabPlugins } from '@/lib/plugins/registry'
import type { Plugin } from '@/types/plugin'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import { PluginPicker } from '@/components/PluginPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  const { addWidget, widgets } = useDashboardStore()
  const { files: datasetFiles } = useDatasetStore()

  // Existing widget names in this tab (for uniqueness check)
  const tabWidgetNames = useMemo(
    () => new Set(widgets.filter(w => w.tabId === tabId).map(w => w.name.toLowerCase())),
    [widgets, tabId]
  )
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

  // Widget name
  const [widgetName, setWidgetName] = useState('')

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
    setWidgetName('')
    setPendingAction(null)
    onOpenChange(false)
  }

  // Generate a unique name by appending a number if needed
  const makeUniqueName = (base: string): string => {
    if (!tabWidgetNames.has(base.toLowerCase())) return base
    let i = 2
    while (tabWidgetNames.has(`${base} ${i}`.toLowerCase())) i++
    return `${base} ${i}`
  }

  const doSelectPlugin = (plugin: Plugin) => {
    setSelectedPluginId(plugin.manifest.id)
    const hasConfig = plugin.manifest.configSchema && Object.keys(plugin.manifest.configSchema).length > 0
    const hasBothLangs = !!(plugin.templates?.python && plugin.templates?.r)

    // Default language for this plugin
    const defaultLang: 'python' | 'r' = plugin.templates?.python ? 'python' : 'r'

    const defaultName = makeUniqueName(plugin.manifest.name[lang] ?? plugin.manifest.name.en ?? plugin.manifest.id)
    setWidgetName(defaultName)

    if (hasConfig || hasBothLangs) {
      setConfigPlugin(plugin)
      setPluginConfig({})
      setPluginLanguage(defaultLang)
    } else {
      // No config needed, add immediately
      const source: DashboardWidgetSource = {
        type: 'plugin',
        pluginId: plugin.manifest.id,
        language: defaultLang,
        config: {},
      }
      addWidget(tabId, source, defaultName, datasetFileId)
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
    const fallbackName = configPlugin.manifest.name[lang] ?? configPlugin.manifest.name.en ?? configPlugin.manifest.id
    const source: DashboardWidgetSource = {
      type: 'plugin',
      pluginId: configPlugin.manifest.id,
      language: pluginLanguage,
      config: { ...pluginConfig },
    }
    addWidget(tabId, source, widgetName.trim() || fallbackName, datasetFileId)
    resetAndClose()
  }

  const doAddInline = (language: 'python' | 'r' | 'sql') => {
    const source: DashboardWidgetSource = {
      type: 'inline',
      language,
      code: `# ${language} code here\n`,
      config: {},
    }
    const name = widgetName.trim() || makeUniqueName(`Custom ${language}`)
    addWidget(tabId, source, name, datasetFileId)
    resetAndClose()
  }

  const handleAddInline = (language: 'python' | 'r' | 'sql') => {
    if (!datasetFileId) {
      setPendingAction(() => () => doAddInline(language))
    } else {
      doAddInline(language)
    }
  }

  const nameError = useMemo(() => {
    const trimmed = widgetName.trim()
    if (!trimmed) return null // will be caught by required check
    if (tabWidgetNames.has(trimmed.toLowerCase())) return t('dashboard.widget_name_taken')
    return null
  }, [widgetName, tabWidgetNames, t])

  const isNameValid = widgetName.trim().length > 0 && !nameError

  // Widget name input shared between views
  const nameInput = (
    <div className="space-y-1">
      <Label className="text-xs">{t('dashboard.widget_name')} *</Label>
      <Input
        value={widgetName}
        onChange={(e) => setWidgetName(e.target.value)}
        placeholder={t('dashboard.widget_name_placeholder')}
        className={cn('h-8 text-sm', nameError && 'border-destructive')}
      />
      {nameError && (
        <p className="text-[10px] text-destructive flex items-center gap-1">
          <TriangleAlert size={10} />
          {nameError}
        </p>
      )}
    </div>
  )

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
        <DialogContent className="sm:max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
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

          <div className="space-y-4 flex-1 min-h-0 overflow-y-auto">
            {nameInput}

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
              <div>
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
            <Button size="sm" onClick={handleConfirmPlugin} disabled={!isNameValid}>
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
      <DialogContent className="sm:max-w-5xl h-[80vh] max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('dashboard.add_widget_title')}</DialogTitle>
          <DialogDescription>
            {t('dashboard.add_widget_description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          {nameInput}
          {datasetSelector}
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-2 flex-1 min-h-0 flex flex-col">
          <TabsList className="shrink-0">
            <TabsTrigger value="plugin" className="text-xs">
              {t('dashboard.source_plugin')}
            </TabsTrigger>
            <TabsTrigger value="inline" className="text-xs">
              {t('dashboard.source_custom_code')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="plugin" className="mt-3 flex-1 min-h-0 flex flex-col">
            <PluginPicker
              plugins={plugins}
              selectedPluginId={selectedPluginId}
              onSelectPlugin={handleSelectPlugin}
              lang={lang}
              fillHeight
            />
          </TabsContent>

          <TabsContent value="inline" className="mt-3">
            <div className="grid grid-cols-3 gap-3">
              {(['python', 'r', 'sql'] as const).map((lang) => (
                <button
                  key={lang}
                  onClick={() => handleAddInline(lang)}
                  className="flex flex-col items-center gap-2 rounded-lg border p-4 text-center transition-colors hover:bg-accent/50"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Code2 size={20} className="text-amber-500" />
                  </div>
                  <p className="text-sm font-medium">{lang.toUpperCase()}</p>
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
