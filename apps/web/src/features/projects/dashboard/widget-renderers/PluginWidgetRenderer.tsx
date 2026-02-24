import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { DashboardWidget } from '@/types'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import { getPlugin, ensurePluginDependencies } from '@/lib/plugins/registry'
import { getComponent } from '@/lib/plugins/component-registry'
import { useDashboardData } from '../DashboardDataProvider'
import { PluginOutputRenderer } from '@/features/projects/lab/datasets/analyses/PluginOutputRenderer'

interface PluginWidgetRendererProps {
  widget: DashboardWidget
}

export function PluginWidgetRenderer({ widget }: PluginWidgetRendererProps) {
  if (widget.source.type !== 'plugin') return null
  const { pluginId } = widget.source

  const plugin = getPlugin(pluginId)

  if (!plugin) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Plugin not found: {pluginId}
      </div>
    )
  }

  // Component-runtime plugins render directly
  if (plugin.componentId && plugin.manifest.runtime.includes('component')) {
    return <ComponentPluginWidget widget={widget} componentId={plugin.componentId} />
  }

  return <ScriptPluginWidget widget={widget} />
}

function ScriptPluginWidget({ widget }: { widget: DashboardWidget }) {
  const { t } = useTranslation()
  const { filteredRows, columns } = useDashboardData()
  const [result, setResult] = useState<RuntimeOutput | null>(null)
  const [loading, setLoading] = useState(false)
  const [runCount, setRunCount] = useState(0)

  const source = widget.source as { type: 'plugin'; pluginId: string; language?: 'python' | 'r'; config: Record<string, unknown> }

  const execute = useCallback(async () => {
    if (columns.length === 0) return

    setLoading(true)
    setResult(null)

    try {
      const executor = await import('@/features/projects/lab/datasets/analysis-executor')
      const plugin = getPlugin(source.pluginId)
      if (!plugin || !plugin.templates) {
        setResult({ stdout: '', stderr: 'Plugin templates not found', figures: [], table: null, html: null })
        return
      }

      // Use persisted language or default
      const language = source.language ?? (plugin.templates.python ? 'python' : 'r')
      const template = language === 'python' ? plugin.templates.python : plugin.templates.r
      if (!template) {
        setResult({ stdout: '', stderr: 'No code template found', figures: [], table: null, html: null })
        return
      }

      // Ensure plugin dependencies are installed (cached per session)
      await ensurePluginDependencies(source.pluginId, language)

      const { resolveTemplate } = await import('@/lib/plugins/template-resolver')
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
  }, [filteredRows, columns, source.pluginId, source.language, source.config])

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
      <PluginOutputRenderer
        result={result}
        isExecuting={loading}
        onRerun={() => setRunCount(c => c + 1)}
        compact
      />
    </div>
  )
}

function ComponentPluginWidget({ widget, componentId }: { widget: DashboardWidget; componentId: string }) {
  const { t } = useTranslation()
  const { filteredRows, columns } = useDashboardData()
  const source = widget.source as { type: 'plugin'; pluginId: string; config: Record<string, unknown> }

  const Component = getComponent(componentId)

  if (columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-3 text-xs text-muted-foreground">
        <AlertTriangle size={14} />
        {t('dashboard.widget_no_dataset')}
      </div>
    )
  }

  if (!Component) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Component not found: {componentId}
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <Component config={source.config} columns={columns} rows={filteredRows} compact />
    </div>
  )
}
