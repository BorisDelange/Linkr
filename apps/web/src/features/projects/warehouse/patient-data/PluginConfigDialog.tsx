import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  usePatientChartStore,
  type PluginWidgetConfig,
} from '@/stores/patient-chart-store'
import { getAnalysisPlugin } from '@/lib/analysis-plugins/registry'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'

interface PluginConfigDialogProps {
  widgetId: string | null
  onOpenChange: (open: boolean) => void
}

export function PluginConfigDialog({ widgetId, onOpenChange }: PluginConfigDialogProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const widget = usePatientChartStore((s) =>
    widgetId ? s.widgets.find((w) => w.id === widgetId) : undefined,
  )
  const updateWidgetConfig = usePatientChartStore((s) => s.updateWidgetConfig)

  const config = widget?.config as PluginWidgetConfig | undefined
  const plugin = config?.pluginId ? getAnalysisPlugin(config.pluginId) : null
  const configSchema = plugin?.manifest.configSchema ?? {}
  const hasConfig = Object.keys(configSchema).length > 0

  const pluginName = plugin
    ? (plugin.manifest.name?.[lang] ?? plugin.manifest.name?.en ?? plugin.manifest.id)
    : ''

  const handleConfigChange = useCallback(
    (changes: Record<string, unknown>) => {
      if (!widgetId || !config) return
      updateWidgetConfig(widgetId, {
        ...config,
        pluginConfig: { ...config.pluginConfig, ...changes },
      })
    },
    [widgetId, config, updateWidgetConfig],
  )

  return (
    <Dialog open={widgetId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {pluginName ? `${pluginName} — ${t('common.settings')}` : t('common.settings')}
          </DialogTitle>
        </DialogHeader>
        {hasConfig ? (
          <GenericConfigPanel
            schema={configSchema}
            config={config?.pluginConfig ?? {}}
            columns={[]}
            onConfigChange={handleConfigChange}
          />
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t('patient_data.no_plugin_config')}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
