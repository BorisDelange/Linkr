import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  usePatientChartStore,
} from '@/stores/patient-chart-store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ArrowLeft } from 'lucide-react'
import { getWarehousePlugins } from '@/lib/plugins/registry'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import { PluginPicker } from '@/components/PluginPicker'
import { ConceptPickerDialog } from './ConceptPickerDialog'
import { ConceptSelectField } from './ConceptSelectField'
import { SizedPatientWidgetPreview } from './PatientWidgetPreview'
import { defaultPatientWidgetLayout } from './patient-grid'
import type { Plugin, PluginConfigField } from '@/types/plugin'

interface AddPatientWidgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tabId: string
  /** Board settings, so the preview is sized against the grid the widget will land on. */
  widgetSpacing?: number
  fitToHeight?: boolean
}

export function AddPatientWidgetDialog({
  open,
  onOpenChange,
  tabId,
  widgetSpacing,
  fitToHeight,
}: AddPatientWidgetDialogProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const addWidget = usePatientChartStore((s) => s.addWidget)

  // Widget name
  const [widgetName, setWidgetName] = useState('')

  // Plugin config step state
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null)
  const [pluginLanguage, setPluginLanguage] = useState<'python' | 'r'>('python')
  const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>({})
  const [conceptPickerOpen, setConceptPickerOpen] = useState(false)

  // All warehouse plugins — built-in widgets (Summary, Timeline, Notes) and
  // custom ones — shown in a single grid harmonized with the dashboard picker.
  const warehousePlugins = useMemo(() => getWarehousePlugins(), [])

  const resetAndClose = () => {
    setConfigPlugin(null)
    setPluginConfig({})
    setPluginLanguage('python')
    setWidgetName('')
    setConceptPickerOpen(false)
    onOpenChange(false)
  }

  const handleSelectPlugin = (plugin: Plugin) => {
    const m = plugin.manifest
    const defaultName = m.name?.[lang] ?? m.name?.en ?? m.id

    // A widget is always a plugin reference now, so built-in and custom plugins
    // take the same path; only the config step differs.
    const hasConfig = m.configSchema && Object.keys(m.configSchema).length > 0
    const hasBothLangs = !!(plugin.templates?.python && plugin.templates?.r)
    const defaultLang: 'python' | 'r' | undefined = plugin.templates
      ? (plugin.templates.python ? 'python' : 'r')
      : undefined

    setWidgetName((prev) => prev || defaultName)

    // Anything with settings — a component widget's schema included — goes through the
    // config + preview step, so the widget is seen before it lands on the board. Only a
    // plugin with nothing to configure is added straight away.
    if (hasConfig || hasBothLangs) {
      setConfigPlugin(plugin)
      setPluginConfig({})
      setPluginLanguage(defaultLang ?? 'python')
    } else {
      addWidget(tabId, m.id, widgetName.trim() || defaultName, {}, defaultLang)
      resetAndClose()
    }
  }

  const handleConfirmPlugin = () => {
    if (!configPlugin) return
    const fallbackName = configPlugin.manifest.name?.[lang] ?? configPlugin.manifest.name?.en ?? configPlugin.manifest.id
    addWidget(
      tabId,
      configPlugin.manifest.id,
      widgetName.trim() || fallbackName,
      { ...pluginConfig },
      // A component plugin has no templates, so it has no language to run.
      configPlugin.templates ? pluginLanguage : undefined,
    )
    resetAndClose()
  }

  const conceptIds = (pluginConfig.conceptIds as number[] | undefined) ?? []

  const renderConceptField = useCallback(
    (_fieldKey: string, field: PluginConfigField) => (
      <ConceptSelectField
        field={field}
        conceptCount={conceptIds.length}
        onOpenPicker={() => setConceptPickerOpen(true)}
      />
    ),
    [conceptIds.length],
  )

  // Debounced config for the preview — avoids re-querying the warehouse on every keystroke.
  const [debouncedConfig, setDebouncedConfig] = useState(pluginConfig)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedConfig(pluginConfig), 300)
    return () => clearTimeout(debounceRef.current)
  }, [pluginConfig])

  // Stable across the config step, so the previewed widget keeps its per-widget caches
  // instead of remounting on every config change.
  const [previewWidgetId] = useState(() => `preview-${crypto.randomUUID()}`)

  // Plugin config step — settings on the left, the widget itself on the right at the
  // footprint it will occupy, the same shape as the dashboard's add-widget dialog.
  if (configPlugin) {
    const pluginName = configPlugin.manifest.name?.[lang] ?? configPlugin.manifest.name?.en ?? configPlugin.manifest.id
    const configHasBothLangs = !!(configPlugin.templates?.python && configPlugin.templates?.r)
    const configSchema = configPlugin.manifest.configSchema as Record<string, PluginConfigField> | undefined
    const hasConfigSchema = !!configSchema && Object.keys(configSchema).length > 0

    return (
      <>
        <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose() }}>
          <DialogContent className="flex h-[80vh] max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
            {/* pr-12 keeps the actions clear of the dialog's own close button, which is
                absolutely positioned in the top-right corner. */}
            <div className="flex shrink-0 items-center gap-2 border-b py-3 pl-4 pr-12">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setConfigPlugin(null)}
              >
                <ArrowLeft size={14} />
              </Button>
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-sm font-semibold">{pluginName}</DialogTitle>
                <DialogDescription className="text-xs">
                  {t('dashboard.plugin_configure_description')}
                </DialogDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => setConfigPlugin(null)}>
                {t('common.back')}
              </Button>
              <Button size="sm" onClick={handleConfirmPlugin} disabled={!widgetName.trim()}>
                {t('dashboard.add_widget')}
              </Button>
            </div>

            <div className="min-h-0 flex-1">
              <Allotment proportionalLayout={false}>
                <Allotment.Pane preferredSize="40%" minSize={280}>
                  <ScrollArea className="h-full">
                    <div className="space-y-4 p-4">
                      <div className="space-y-2">
                        <Label>{t('patient_data.widget_name')}<RequiredMark /></Label>
                        <Input
                          value={widgetName}
                          onChange={(e) => setWidgetName(e.target.value)}
                          placeholder={t('patient_data.widget_name_placeholder')}
                          className="h-8 text-sm"
                        />
                      </div>

                      {configHasBothLangs && (
                        <div className="space-y-1">
                          <Label>{t('common.language')}</Label>
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
                        <GenericConfigPanel
                          schema={configSchema}
                          config={pluginConfig}
                          columns={[]}
                          onConfigChange={(changes) => setPluginConfig((prev) => ({ ...prev, ...changes }))}
                          renderConceptField={renderConceptField}
                        />
                      )}
                    </div>
                  </ScrollArea>
                </Allotment.Pane>

                <Allotment.Pane minSize={280}>
                  <div className="h-full border-l">
                    <SizedPatientWidgetPreview
                      pluginId={configPlugin.manifest.id}
                      widgetId={previewWidgetId}
                      config={debouncedConfig}
                      layout={defaultPatientWidgetLayout(configPlugin.manifest.id)}
                      widgetSpacing={widgetSpacing}
                      fitToHeight={fitToHeight}
                    />
                  </div>
                </Allotment.Pane>
              </Allotment>
            </div>
          </DialogContent>
        </Dialog>

        {conceptPickerOpen && (
          <ConceptPickerDialog
            open
            onOpenChange={setConceptPickerOpen}
            config={pluginConfig}
            // The settings already live in this dialog's left pane, so the picker opens
            // straight on its concept table with no second settings form.
            initialTab="concepts"
            onConfirm={(picked) => {
              setPluginConfig((prev) => ({ ...prev, ...picked }))
              setConceptPickerOpen(false)
            }}
          />
        )}
      </>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose() }}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] flex-col overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t('patient_data.add_widget_title')}</DialogTitle>
          <DialogDescription>
            {t('patient_data.add_widget_description')}
          </DialogDescription>
        </DialogHeader>

        <div className="shrink-0 space-y-2">
          <Label>{t('patient_data.widget_name')}<RequiredMark /></Label>
          <Input
            value={widgetName}
            onChange={(e) => setWidgetName(e.target.value)}
            placeholder={t('patient_data.widget_name_placeholder')}
            className="h-8 text-sm"
          />
        </div>

        <div className="mt-2 flex min-h-0 flex-1 flex-col">
          <PluginPicker
            plugins={warehousePlugins}
            selectedPluginId=""
            onSelectPlugin={handleSelectPlugin}
            lang={lang}
            fillHeight
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
