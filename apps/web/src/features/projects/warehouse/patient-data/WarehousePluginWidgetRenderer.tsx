import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { usePatientChartContext } from './PatientChartContext'
import { usePatientScope } from './use-patient-scope'
import { getPlugin, ensurePluginDependencies } from '@/lib/plugins/registry'
import { PluginOutputRenderer } from '@/features/projects/lab/datasets/analyses/PluginOutputRenderer'
import { buildTimelineQuery, buildPatientVisitSummaryQuery } from '@/lib/duckdb/patient-data-queries'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { ExecuteNotPermitted } from '@/components/ui/execute-not-permitted'
import { localized } from '@/lib/localized'
import { forgetDeclinedCode } from '@/stores/code-acceptance-prompt'

interface WarehousePluginWidgetRendererProps {
  widgetId: string
}

export function WarehousePluginWidgetRenderer({ widgetId }: WarehousePluginWidgetRendererProps) {
  const { t, i18n } = useTranslation()
  const { dataSourceId, projectUid, schemaMapping, can, codeWidgets = true } = usePatientChartContext()
  const widget = usePatientChartStore((s) => s.widgets.find((w) => w.id === widgetId))
  const selectedPatientId = usePatientChartStore((s) => s.selectedPatientId[projectUid] ?? null)
  const selectedVisitId = usePatientChartStore((s) => s.selectedVisitId[projectUid] ?? null)
  const { scope } = usePatientScope(projectUid, dataSourceId, schemaMapping)
  const selectedVisitDetailId = usePatientChartStore((s) => s.selectedVisitDetailId[projectUid] ?? null)
  const projectRole = useMyProjectRole(projectUid)
  const canExecute = codeWidgets && (can ?? projectRole.can)('patient-data:execute')

  const [result, setResult] = useState<RuntimeOutput | null>(null)
  const [loading, setLoading] = useState(false)
  const [runCount, setRunCount] = useState(0)

  const pluginId = widget?.pluginId
  const language = widget?.language
  const pluginConfig = widget?.config

  const plugin = pluginId ? getPlugin(pluginId) : null

  // Build extra variables for plugins with needsConceptPicker (inject pre-built SQL)
  const extraVars = useMemo(() => {
    if (!plugin?.manifest.needsConceptPicker || !schemaMapping || !selectedPatientId) return undefined
    const conceptIds = (pluginConfig as Record<string, unknown> | undefined)?.conceptIds as number[] | undefined
    const timelineSql = conceptIds?.length
      ? buildTimelineQuery(schemaMapping, conceptIds, selectedPatientId, scope)
      : null
    const visitSummarySql = buildPatientVisitSummaryQuery(schemaMapping, selectedPatientId)

    return { timeline_sql: timelineSql, visit_summary_sql: visitSummarySql }
  }, [plugin, schemaMapping, selectedPatientId, scope, pluginConfig])

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
        extraVars,
        { source: template, label: widget ? localized(widget.name, i18n.language) : undefined },
      )
      setResult(output)
    } catch (err) {
      setResult({ stdout: '', stderr: String(err), figures: [], table: null, html: null })
    } finally {
      setLoading(false)
    }
  }, [plugin, language, pluginConfig, dataSourceId, selectedPatientId, selectedVisitId, selectedVisitDetailId, extraVars, widget, i18n.language])

  // Re-execute when patient context or config changes (only if allowed to run code).
  useEffect(() => {
    if (selectedPatientId && canExecute) {
      execute()
    } else {
      setResult(null)
    }
  }, [execute, runCount, selectedPatientId, canExecute])

  if (!pluginId || !plugin) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-3 text-xs text-muted-foreground">
        <AlertTriangle size={14} />
        {t('patient_data.no_plugin_configured')}
      </div>
    )
  }

  if (!codeWidgets) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-3 text-center text-xs text-muted-foreground">
        <AlertTriangle size={14} className="shrink-0" />
        {t('patient_data.code_widget_needs_project')}
      </div>
    )
  }

  // Read-only user: this widget runs R/Python they can't execute.
  if (!canExecute) return <ExecuteNotPermitted compact />

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
        onRerun={() => { forgetDeclinedCode(); setRunCount((c) => c + 1) }}
        compact
      />
    </div>
  )
}
