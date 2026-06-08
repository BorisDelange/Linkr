import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  usePatientChartStore,
  type PluginWidgetConfig,
} from '@/stores/patient-chart-store'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowLeft } from 'lucide-react'
import { getWarehousePlugins } from '@/lib/plugins/registry'
import { SYSTEM_WIDGET_TYPE_MAP } from '@/lib/plugins/builtin-widget-plugins'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import { PluginPicker } from '@/components/PluginPicker'
import type { Plugin, PluginConfigField } from '@/types/plugin'

interface AddPatientWidgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tabId: string
}

export function AddPatientWidgetDialog({
  open,
  onOpenChange,
  tabId,
}: AddPatientWidgetDialogProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const { addWidget } = usePatientChartStore()

  // Widget name
  const [widgetName, setWidgetName] = useState('')

  // Plugin config step state
  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null)
  const [pluginLanguage, setPluginLanguage] = useState<'python' | 'r'>('python')
  const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>({})

  // All warehouse plugins — built-in widgets (Summary, Timeline, Notes) and
  // custom ones — shown in a single grid harmonized with the dashboard picker.
  const warehousePlugins = useMemo(() => getWarehousePlugins(), [])

  const resetAndClose = () => {
    setConfigPlugin(null)
    setPluginConfig({})
    setPluginLanguage('python')
    setWidgetName('')
    onOpenChange(false)
  }

  const handleSelectPlugin = (plugin: Plugin) => {
    const m = plugin.manifest
    const defaultName = m.name?.[lang] ?? m.name?.en ?? m.id

    // Built-in system widget → add directly as its native widget type.
    const systemType = SYSTEM_WIDGET_TYPE_MAP[m.id]
    if (systemType) {
      addWidget(tabId, systemType, widgetName.trim() || defaultName)
      resetAndClose()
      return
    }

    // Custom plugin → config step when it needs configuration / language choice.
    const hasConfig = m.configSchema && Object.keys(m.configSchema).length > 0
    const hasBothLangs = !!(plugin.templates?.python && plugin.templates?.r)
    const defaultLang: 'python' | 'r' = plugin.templates?.python ? 'python' : 'r'

    setWidgetName((prev) => prev || defaultName)

    if (hasConfig || hasBothLangs) {
      setConfigPlugin(plugin)
      setPluginConfig({})
      setPluginLanguage(defaultLang)
    } else {
      const config: PluginWidgetConfig = {
        pluginId: m.id,
        language: defaultLang,
        pluginConfig: {},
      }
      addWidget(tabId, 'plugin', widgetName.trim() || defaultName, config)
      resetAndClose()
    }
  }

  const handleConfirmPlugin = () => {
    if (!configPlugin) return
    const fallbackName = configPlugin.manifest.name?.[lang] ?? configPlugin.manifest.name?.en ?? configPlugin.manifest.id
    const config: PluginWidgetConfig = {
      pluginId: configPlugin.manifest.id,
      language: pluginLanguage,
      pluginConfig: { ...pluginConfig },
    }
    addWidget(tabId, 'plugin', widgetName.trim() || fallbackName, config)
    resetAndClose()
  }

  // Plugin config step view
  if (configPlugin) {
    const pluginName = configPlugin.manifest.name?.[lang] ?? configPlugin.manifest.name?.en ?? configPlugin.manifest.id
    const configHasBothLangs = !!(configPlugin.templates?.python && configPlugin.templates?.r)
    const hasConfigSchema = configPlugin.manifest.configSchema && Object.keys(configPlugin.manifest.configSchema).length > 0

    return (
      <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose() }}>
        <DialogContent className="sm:max-w-lg">
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
            <div className="space-y-1">
              <Label className="text-xs">{t('patient_data.widget_name')}</Label>
              <Input
                value={widgetName}
                onChange={(e) => setWidgetName(e.target.value)}
                placeholder={t('patient_data.widget_name_placeholder')}
                className="h-8 text-sm"
              />
            </div>

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
                  schema={configPlugin.manifest.configSchema as Record<string, PluginConfigField>}
                  config={pluginConfig}
                  columns={[]}
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
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose() }}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] flex-col overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t('patient_data.add_widget_title')}</DialogTitle>
          <DialogDescription>
            {t('patient_data.add_widget_description')}
          </DialogDescription>
        </DialogHeader>

        <div className="shrink-0">
          <Label className="text-xs">{t('patient_data.widget_name')}</Label>
          <Input
            value={widgetName}
            onChange={(e) => setWidgetName(e.target.value)}
            placeholder={t('patient_data.widget_name_placeholder')}
            className="mt-1 h-8 text-sm"
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
