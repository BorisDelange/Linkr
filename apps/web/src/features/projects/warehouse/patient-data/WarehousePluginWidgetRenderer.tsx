import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import {
  usePatientChartStore,
  type PluginWidgetConfig,
} from '@/stores/patient-chart-store'
import { usePatientChartContext } from './PatientChartContext'
import { getPlugin, ensurePluginDependencies } from '@/lib/plugins/registry'
import { PluginOutputRenderer } from '@/features/projects/lab/datasets/analyses/PluginOutputRenderer'
import { buildTimelineQuery, buildPatientVisitSummaryQuery } from '@/lib/duckdb/patient-data-queries'

interface WarehousePluginWidgetRendererProps {
  widgetId: string
}

export function WarehousePluginWidgetRenderer({ widgetId }: WarehousePluginWidgetRendererProps) {
  const { t } = useTranslation()
  const { dataSourceId, projectUid, schemaMapping } = usePatientChartContext()
  const widget = usePatientChartStore((s) => s.widgets.find((w) => w.id === widgetId))
  const selectedPatientId = usePatientChartStore((s) => s.selectedPatientId[projectUid] ?? null)
  const selectedVisitId = usePatientChartStore((s) => s.selectedVisitId[projectUid] ?? null)
  const selectedVisitDetailId = usePatientChartStore((s) => s.selectedVisitDetailId[projectUid] ?? null)

  const [result, setResult] = useState<RuntimeOutput | null>(null)
  const [loading, setLoading] = useState(false)
  const [runCount, setRunCount] = useState(0)

  const config = widget?.config as PluginWidgetConfig | undefined
  const pluginId = config?.pluginId
  const language = config?.language
  const pluginConfig = config?.pluginConfig

  const plugin = pluginId ? getPlugin(pluginId) : null

  // Build extra preamble for plugins with needsConceptPicker (inject pre-built SQL)
  const extraPreamble = useMemo(() => {
    if (!plugin?.manifest.needsConceptPicker || !schemaMapping || !selectedPatientId) return undefined
    const conceptIds = (pluginConfig as Record<string, unknown> | undefined)?.conceptIds as number[] | undefined
    const timelineSql = conceptIds?.length
      ? buildTimelineQuery(schemaMapping, conceptIds, selectedPatientId, selectedVisitId)
      : null
    const visitSummarySql = buildPatientVisitSummaryQuery(schemaMapping, selectedPatientId)

    if (language === 'python') {
      return [
        `timeline_sql = ${timelineSql ? JSON.stringify(timelineSql) : 'None'}`,
        `visit_summary_sql = ${visitSummarySql ? JSON.stringify(visitSummarySql) : 'None'}`,
        '',
      ].join('\n')
    }
    // R
    return [
      `timeline_sql <- ${timelineSql ? JSON.stringify(timelineSql) : 'NULL'}`,
      `visit_summary_sql <- ${visitSummarySql ? JSON.stringify(visitSummarySql) : 'NULL'}`,
      '',
    ].join('\n')
  }, [plugin, schemaMapping, selectedPatientId, selectedVisitId, pluginConfig, language])

  const execute = useCallback(async () => {
    if (!plugin || !plugin.templates || !language || !dataSourceId) return

    const template = language === 'python' ? plugin.templates.python : plugin.templates.r
    if (!template) {
      setResult({ stdout: '', stderr: 'No code template found for this language', figures: [], table: null, html: null })
      return
    }

    setLoading(true)
    setResult(null)

    try {
      // Install dependencies if needed
      await ensurePluginDependencies(plugin.manifest.id, language)

      // Resolve template with plugin config
      const { resolveTemplate } = await import('@/lib/plugins/template-resolver')
      const code = resolveTemplate(
        template,
        pluginConfig ?? {},
        [], // no dataset columns in warehouse context
        plugin.manifest.configSchema,
        language,
      )

      // Execute with patient context
      const executor = await import('./warehouse-plugin-executor')
      const exec = language === 'r'
        ? executor.executeWarehousePluginR
        : executor.executeWarehousePluginPython

      const output = await exec(
        code,
        dataSourceId,
        selectedPatientId,
        selectedVisitId,
        selectedVisitDetailId,
        extraPreamble,
      )
      setResult(output)
    } catch (err) {
      setResult({ stdout: '', stderr: String(err), figures: [], table: null, html: null })
    } finally {
      setLoading(false)
    }
  }, [plugin, language, pluginConfig, dataSourceId, selectedPatientId, selectedVisitId, selectedVisitDetailId, extraPreamble])

  // Re-execute when patient context or config changes
  useEffect(() => {
    if (selectedPatientId) {
      execute()
    } else {
      setResult(null)
    }
  }, [execute, runCount, selectedPatientId])

  if (!pluginId || !plugin) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-3 text-xs text-muted-foreground">
        <AlertTriangle size={14} />
        {t('patient_data.no_plugin_configured')}
      </div>
    )
  }

  if (!dataSourceId) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-3 text-xs text-muted-foreground">
        <AlertTriangle size={14} />
        {t('patient_data.no_database')}
      </div>
    )
  }

  if (!selectedPatientId) {
    return (
      <div className="flex h-full items-center justify-center p-3 text-xs text-muted-foreground">
        {t('patient_data.select_patient_first')}
      </div>
    )
  }

  return (
    <div className="h-full overflow-hidden">
      <PluginOutputRenderer
        result={result}
        isExecuting={loading}
        onRerun={() => setRunCount((c) => c + 1)}
        compact
      />
    </div>
  )
}
