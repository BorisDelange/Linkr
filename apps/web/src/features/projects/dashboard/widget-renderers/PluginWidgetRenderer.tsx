import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { DashboardWidget } from '@/types'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import { getAnalysisPlugin } from '@/lib/analysis-plugins/registry'
import { useDashboardData } from '../DashboardDataProvider'
import { AnalysisOutputRenderer } from '@/features/projects/lab/datasets/analyses/AnalysisOutputRenderer'

interface PluginWidgetRendererProps {
  widget: DashboardWidget
}

export function PluginWidgetRenderer({ widget }: PluginWidgetRendererProps) {
  if (widget.source.type !== 'plugin') return null
  const { pluginId } = widget.source

  const plugin = getAnalysisPlugin(pluginId)

  if (!plugin) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Plugin not found: {pluginId}
      </div>
    )
  }

  if (plugin.jsComponent && !plugin.templates) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        This plugin type is not supported in dashboard widgets
      </div>
    )
  }

  return <ScriptPluginWidget widget={widget} />
}

function ScriptPluginWidget({ widget }: { widget: DashboardWidget }) {
  const { t } = useTranslation()
  const { filteredRows, columns } = useDashboardData()
  const [result, setResult] = useState<RuntimeOutput | null>(null)
  const [loading, setLoading] = useState(false)
  const [runCount, setRunCount] = useState(0)

  const source = widget.source as { type: 'plugin'; pluginId: string; config: Record<string, unknown> }

  const execute = useCallback(async () => {
    if (columns.length === 0) return

    setLoading(true)
    setResult(null)

    try {
      const executor = await import('@/features/projects/lab/datasets/analysis-executor')
      const plugin = getAnalysisPlugin(source.pluginId)
      if (!plugin || !plugin.templates) {
        setResult({ stdout: '', stderr: 'Plugin templates not found', figures: [], table: null, html: null })
        return
      }

      // Detect language: prefer Python, fallback to R
      const language = plugin.templates.python ? 'python' : 'r'
      const template = language === 'python' ? plugin.templates.python : plugin.templates.r
      if (!template) {
        setResult({ stdout: '', stderr: 'No code template found', figures: [], table: null, html: null })
        return
      }

      const { resolveTemplate } = await import('@/lib/analysis-plugins/template-resolver')
      const code = resolveTemplate(
        template,
        source.config,
        columns,
        plugin.manifest.configSchema,
        language,
      )

      const exec = language === 'r' ? executor.executeAnalysisCodeR : executor.executeAnalysisCode
      const output = await exec(code, filteredRows, columns)
      setResult(output)
    } catch (err) {
      setResult({ stdout: '', stderr: String(err), figures: [], table: null, html: null })
    } finally {
      setLoading(false)
    }
  }, [filteredRows, columns, source.pluginId, source.config])

  useEffect(() => {
    execute()
  }, [execute, runCount])

  // No dataset configured
  if (columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-3 text-xs text-muted-foreground">
        <AlertTriangle size={14} />
        {t('dashboard.widget_no_dataset')}
      </div>
    )
  }

  return (
    <div className="h-full overflow-hidden">
      <AnalysisOutputRenderer
        result={result}
        isExecuting={loading}
        onRerun={() => setRunCount(c => c + 1)}
      />
    </div>
  )
}
