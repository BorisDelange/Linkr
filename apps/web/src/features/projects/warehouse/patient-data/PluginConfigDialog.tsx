import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  usePatientChartStore,
  type PluginWidgetConfig,
} from '@/stores/patient-chart-store'
import { getPlugin } from '@/lib/plugins/registry'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import { ConceptPickerDialog } from './ConceptPickerDialog'

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
  const plugin = config?.pluginId ? getPlugin(config.pluginId) : null
  const configSchema = plugin?.manifest.configSchema ?? {}
  const hasConfig = Object.keys(configSchema).length > 0
  const needsConceptPicker = plugin?.manifest.needsConceptPicker ?? false

  const pluginName = plugin
    ? (plugin.manifest.name?.[lang] ?? plugin.manifest.name?.en ?? plugin.manifest.id)
    : ''

  // Concept picker sub-dialog state
  const [conceptPickerOpen, setConceptPickerOpen] = useState(false)
  const conceptIds = ((config?.pluginConfig as Record<string, unknown> | undefined)?.conceptIds as number[] | undefined) ?? []

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

  const handleConceptsConfirm = useCallback(
    (ids: number[]) => {
      if (!widgetId || !config) return
      updateWidgetConfig(widgetId, {
        ...config,
        pluginConfig: { ...config.pluginConfig, conceptIds: ids },
      })
      setConceptPickerOpen(false)
    },
    [widgetId, config, updateWidgetConfig],
  )

  return (
    <>
      <Dialog open={widgetId !== null} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pluginName ? `${pluginName} — ${t('common.settings')}` : t('common.settings')}
            </DialogTitle>
          </DialogHeader>

          {/* Concept picker button */}
          {needsConceptPicker && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setConceptPickerOpen(true)}
              >
                <ListChecks size={14} />
                {t('patient_data.select_concepts')}
              </Button>
              <Badge variant="secondary" className="text-xs">
                {t('patient_data.concepts_selected', { count: conceptIds.length })}
              </Badge>
            </div>
          )}

          {hasConfig ? (
            <GenericConfigPanel
              schema={configSchema}
              config={config?.pluginConfig ?? {}}
              columns={[]}
              onConfigChange={handleConfigChange}
            />
          ) : !needsConceptPicker ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {t('patient_data.no_plugin_config')}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Concept picker sub-dialog */}
      {needsConceptPicker && (
        <ConceptPickerDialog
          open={conceptPickerOpen}
          onOpenChange={setConceptPickerOpen}
          selectedConceptIds={conceptIds}
          onConfirm={handleConceptsConfirm}
        />
      )}
    </>
  )
}
