import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Code2, ArrowLeft, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PluginPicker } from '@/components/PluginPicker'
import { GenericConfigPanel } from './analyses/GenericConfigPanel'
import { useDatasetStore } from '@/stores/dataset-store'
import { getLabPlugins } from '@/lib/plugins/registry'
import { getComponent, componentSupportsServer } from '@/lib/plugins/component-registry'
import { isServerMode } from '@/lib/api-client'
import type { Plugin, PluginConfigField } from '@/types/plugin'

type InlineLanguage = 'python' | 'r' | 'sql'

interface CreateAnalysisDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  datasetFileId: string
}

/**
 * Add-analysis dialog, mirroring the dashboard "Add a widget" modal: a name
 * field, a Plugin tab (built-in components + user plugins via PluginPicker) and a
 * Custom code tab (Python/R/SQL). Component plugins with config open a second
 * view with a live preview. No dataset selector — the dataset is the one the
 * analysis panel belongs to (fixed prop). Creates a DatasetAnalysis; inline code
 * is stored as type 'inline' with { language, code } in config.
 */
export function CreateAnalysisDialog({ open, onOpenChange, datasetFileId }: CreateAnalysisDialogProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const { analyses, files, getFileRows, createAnalysis } = useDatasetStore()

  const plugins = useMemo(() => getLabPlugins(), [])
  const [activeTab, setActiveTab] = useState('plugin')
  const [selectedPluginId, setSelectedPluginId] = useState('')
  const [name, setName] = useState('')

  // Second view: plugin config + live preview
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null)
  const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>({})
  const [pluginLanguage, setPluginLanguage] = useState<'python' | 'r'>('python')

  const datasetFile = files.find((f) => f.id === datasetFileId)
  const columns = datasetFile?.columns ?? []
  const rows = getFileRows(datasetFileId)

  useEffect(() => {
    if (open) {
      setActiveTab('plugin')
      setSelectedPluginId('')
      setName('')
      setConfigPlugin(null)
      setPluginConfig({})
      setPluginLanguage('python')
    }
  }, [open])

  const existingNames = useMemo(
    () => new Set(analyses.filter((a) => a.datasetFileId === datasetFileId).map((a) => a.name.toLowerCase())),
    [analyses, datasetFileId],
  )
  const makeUniqueName = (base: string): string => {
    if (!existingNames.has(base.toLowerCase())) return base
    let i = 2
    while (existingNames.has(`${base} ${i}`.toLowerCase())) i++
    return `${base} ${i}`
  }

  const nameError = useMemo(() => {
    const trimmed = name.trim()
    if (!trimmed) return null
    if (existingNames.has(trimmed.toLowerCase())) return t('datasets.analysis_name_exists')
    return null
  }, [name, existingNames, t])
  const isNameValid = name.trim().length > 0 && !nameError

  const resetAndClose = () => {
    setConfigPlugin(null)
    setPluginConfig({})
    setPluginLanguage('python')
    setSelectedPluginId('')
    setName('')
    onOpenChange(false)
  }

  const doSelectPlugin = (plugin: Plugin) => {
    setSelectedPluginId(plugin.manifest.id)
    const hasConfig = plugin.manifest.configSchema && Object.keys(plugin.manifest.configSchema).length > 0
    const hasBothLangs = !!(plugin.templates?.python && plugin.templates?.r)
    const defaultLang: 'python' | 'r' = plugin.templates?.python ? 'python' : 'r'
    const defaultName = makeUniqueName(plugin.manifest.name[lang] ?? plugin.manifest.name.en ?? plugin.manifest.id)
    setName(defaultName)

    if (hasConfig || hasBothLangs) {
      setConfigPlugin(plugin)
      setPluginConfig({})
      setPluginLanguage(defaultLang)
    } else {
      // No config — create immediately.
      const isComponent = plugin.manifest.runtime.includes('component')
      createAnalysis(datasetFileId, defaultName, plugin.manifest.id, isComponent ? {} : { language: defaultLang })
      resetAndClose()
    }
  }

  const handleConfirmPlugin = () => {
    if (!configPlugin) return
    const fallback = configPlugin.manifest.name[lang] ?? configPlugin.manifest.name.en ?? configPlugin.manifest.id
    const isComponent = configPlugin.manifest.runtime.includes('component')
    const config = isComponent
      ? { ...pluginConfig }
      : { ...pluginConfig, language: pluginLanguage }
    createAnalysis(datasetFileId, name.trim() || fallback, configPlugin.manifest.id, config)
    resetAndClose()
  }

  const handleAddInline = (language: InlineLanguage) => {
    const analysisName = name.trim() || makeUniqueName(`Custom ${language.toUpperCase()}`)
    createAnalysis(datasetFileId, analysisName, 'inline', {
      language,
      code: `# ${language} code here\n`,
    })
    resetAndClose()
  }

  // Debounced config for the preview — avoids re-rendering on every keystroke.
  const [debouncedConfig, setDebouncedConfig] = useState(pluginConfig)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedConfig(pluginConfig), 300)
    return () => clearTimeout(debounceRef.current)
  }, [pluginConfig])

  const nameInput = (
    <div className="space-y-1">
      <Label className="text-xs">{t('datasets.name')} *</Label>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('datasets.new_analysis')}
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

  // --- Plugin config + live preview view ---
  if (configPlugin) {
    const pluginName = configPlugin.manifest.name[lang] ?? configPlugin.manifest.name.en ?? configPlugin.manifest.id
    const configHasBothLangs = !!(configPlugin.templates?.python && configPlugin.templates?.r)
    const hasConfigSchema = configPlugin.manifest.configSchema && Object.keys(configPlugin.manifest.configSchema).length > 0
    const isComponentPlugin = !!(configPlugin.componentId && configPlugin.manifest.runtime.includes('component'))
    const PreviewComponent = isComponentPlugin && configPlugin.componentId ? getComponent(configPlugin.componentId) : null

    return (
      <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose() }}>
        <DialogContent className="sm:max-w-6xl h-[80vh] max-h-[80vh] overflow-hidden flex flex-col p-0 gap-0">
          <div className="flex items-center gap-2 border-b px-4 py-3 shrink-0">
            <Button variant="ghost" size="icon-xs" onClick={() => setConfigPlugin(null)}>
              <ArrowLeft size={14} />
            </Button>
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-semibold truncate">{pluginName}</h2>
              <p className="text-xs text-muted-foreground">{t('dashboard.plugin_configure_description')}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setConfigPlugin(null)}>
              {t('common.back')}
            </Button>
            <Button size="sm" onClick={handleConfirmPlugin} disabled={!isNameValid}>
              {t('common.create')}
            </Button>
          </div>

          <div className="flex-1 min-h-0">
            <Allotment proportionalLayout={false}>
              <Allotment.Pane preferredSize="45%" minSize={280}>
                <ScrollArea className="h-full">
                  <div className="space-y-4 p-4">
                    {nameInput}
                    {configHasBothLangs && (
                      <div className="space-y-1">
                        <Label className="text-xs">{t('common.language')}</Label>
                        <Select value={pluginLanguage} onValueChange={(v) => setPluginLanguage(v as 'python' | 'r')}>
                          <SelectTrigger className="h-8 w-40 text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent position="popper" sideOffset={4}>
                            <SelectItem value="python">Python</SelectItem>
                            <SelectItem value="r">R</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {hasConfigSchema && (
                      <div className="-mx-3 -mt-1">
                        <GenericConfigPanel
                          schema={configPlugin.manifest.configSchema as Record<string, PluginConfigField>}
                          config={pluginConfig}
                          columns={columns}
                          onConfigChange={(changes) => setPluginConfig((prev) => ({ ...prev, ...changes }))}
                          rows={rows}
                        />
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </Allotment.Pane>

              <Allotment.Pane minSize={200}>
                <div className="h-full overflow-auto border-l bg-muted/30">
                  {PreviewComponent && isServerMode() && configPlugin.componentId && !componentSupportsServer(configPlugin.componentId) ? (
                    <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
                      {t('datasets.component_server_unavailable')}
                    </div>
                  ) : PreviewComponent ? (
                    // eslint-disable-next-line react-hooks/static-components -- component resolved from plugin data
                    <PreviewComponent
                      config={debouncedConfig}
                      columns={columns}
                      rows={rows}
                      datasetFileId={isServerMode() ? datasetFileId : undefined}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">
                      {t('dashboard.preview_not_available')}
                    </div>
                  )}
                </div>
              </Allotment.Pane>
            </Allotment>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose() }}>
      <DialogContent className="sm:max-w-5xl h-[80vh] max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('datasets.new_analysis')}</DialogTitle>
          <DialogDescription>{t('datasets.new_analysis_description')}</DialogDescription>
        </DialogHeader>

        {nameInput}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-2 flex-1 min-h-0 flex flex-col">
          <TabsList className="shrink-0 self-center">
            <TabsTrigger value="plugin" className="text-xs">{t('dashboard.source_plugin')}</TabsTrigger>
            <TabsTrigger value="inline" className="text-xs">{t('dashboard.source_custom_code')}</TabsTrigger>
          </TabsList>

          <TabsContent value="plugin" className="mt-3 flex-1 min-h-0 flex flex-col">
            <PluginPicker
              plugins={plugins}
              selectedPluginId={selectedPluginId}
              onSelectPlugin={doSelectPlugin}
              lang={lang}
              fillHeight
            />
          </TabsContent>

          <TabsContent value="inline" className="mt-3">
            <div className="grid grid-cols-3 gap-3">
              {(['python', 'r', 'sql'] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => handleAddInline(l)}
                  className="flex flex-col items-center gap-2 rounded-lg border p-4 text-center transition-colors hover:bg-accent/50"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Code2 size={20} className="text-amber-500" />
                  </div>
                  <p className="text-sm font-medium">{l.toUpperCase()}</p>
                </button>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
