import { useState, useEffect } from 'react'
import type { DashboardWidget } from '@/types'
import { getAnalysisPlugin } from '@/lib/analysis-plugins/registry'
import { useDashboardData } from '../DashboardDataProvider'
import { Loader2 } from 'lucide-react'

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

  // JS-widget plugins require a DatasetAnalysis context not available in dashboard widgets.
  // Only script-based plugins are supported here.
  if (plugin.jsComponent && !plugin.templates) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        This plugin type is not supported in dashboard widgets
      </div>
    )
  }

  // Script runtime: execute code and show output
  return <ScriptPluginWidget widget={widget} />
}

function LoadingSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 size={16} className="animate-spin text-muted-foreground" />
    </div>
  )
}

function ScriptPluginWidget({ widget }: { widget: DashboardWidget }) {
  const { filteredRows, columns } = useDashboardData()
  const [output, setOutput] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const source = widget.source as { type: 'plugin'; pluginId: string; config: Record<string, unknown> }

  useEffect(() => {
    if (filteredRows.length === 0) {
      setOutput('No data available')
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    // Dynamically import the analysis executor to avoid circular deps
    import('@/features/projects/lab/datasets/analysis-executor').then(async (executor) => {
      try {
        const plugin = getAnalysisPlugin(source.pluginId)
        if (!plugin || !plugin.templates) {
          if (!cancelled) setError('Plugin templates not found')
          return
        }

        // Use Python template by default
        const template = plugin.templates.python ?? plugin.templates.r
        if (!template) {
          if (!cancelled) setError('No code template found')
          return
        }

        // Resolve template with config
        const { resolveTemplate } = await import('@/lib/analysis-plugins/template-resolver')
        const code = resolveTemplate(
          template,
          source.config,
          columns,
          plugin.manifest.configSchema,
          plugin.templates.python ? 'python' : 'r',
        )

        const result = await executor.executeAnalysisCode(code, filteredRows, columns)
        if (!cancelled) {
          if (result.stderr) {
            setError(result.stderr)
          } else {
            setOutput(result.stdout || 'Execution complete')
          }
        }
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }).catch((err) => {
      if (!cancelled) {
        setError(`Failed to load executor: ${err}`)
        setLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [filteredRows, columns, source.pluginId, source.config])

  if (loading) return <LoadingSpinner />

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-2">
        <div className="text-xs text-destructive max-w-full overflow-auto">{error}</div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-2">
      <pre className="text-xs whitespace-pre-wrap">{output}</pre>
    </div>
  )
}
