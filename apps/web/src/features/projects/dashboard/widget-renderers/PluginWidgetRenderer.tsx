import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { DashboardWidget } from '@/types'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import { getPlugin, ensurePluginDependencies } from '@/lib/plugins/registry'
import { getComponent } from '@/lib/plugins/component-registry'
import { useDashboardData } from '../DashboardDataProvider'
import { resolveServerFilters } from '../resolve-server-filters'
import { useWidgetExecution } from './use-widget-execution'
import { PluginOutputRenderer } from '@/features/projects/lab/datasets/analyses/PluginOutputRenderer'
import { isServerMode } from '@/lib/api-client'
import { executeOnServer } from '@/lib/api/execution'
import { useAppStore } from '@/stores/app-store'

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
  const { filteredRows, columns, reloadOnTabSwitch, dataSignature, datasetFileId, filters } = useDashboardData()
  const activeProjectUid = useAppStore((s) => s.activeProjectUid)

  const source = widget.source as { type: 'plugin'; pluginId: string; language?: 'python' | 'r'; config: Record<string, unknown> }

  const run = async (): Promise<RuntimeOutput> => {
    const plugin = getPlugin(source.pluginId)
    if (!plugin || !plugin.templates) {
      return { stdout: '', stderr: 'Plugin templates not found', figures: [], table: null, html: null }
    }

    // Use persisted language or default
    const language = source.language ?? (plugin.templates.python ? 'python' : 'r')
    const template = language === 'python' ? plugin.templates.python : plugin.templates.r
    if (!template) {
      return { stdout: '', stderr: 'No code template found', figures: [], table: null, html: null }
    }

    const { resolveTemplate } = await import('@/lib/plugins/template-resolver')
    const code = resolveTemplate(
      template,
      source.config,
      columns,
      plugin.manifest.configSchema,
      language,
    )

    try {
      if (isServerMode()) {
        return await executeOnServer(language, code, {
          projectUid: activeProjectUid ?? undefined,
          datasetFileId: datasetFileId ?? undefined,
          datasetFilters: datasetFileId ? resolveServerFilters(filters, columns) : undefined,
        })
      }
      // Ensure plugin dependencies are installed (cached per session) — WASM only.
      await ensurePluginDependencies(source.pluginId, language)
      const executor = await import('@/features/projects/lab/datasets/analysis-executor')
      const exec = language === 'r' ? executor.executeAnalysisCodeR : executor.executeAnalysisCode
      return await exec(code, filteredRows, columns)
    } catch (err) {
      return { stdout: '', stderr: String(err), figures: [], table: null, html: null }
    }
  }

  const { result, loading, rerun } = useWidgetExecution({
    widgetId: widget.id,
    signature: `${source.pluginId}|${source.language ?? ''}|${JSON.stringify(source.config)}|${dataSignature}`,
    ready: columns.length > 0,
    alwaysReload: reloadOnTabSwitch,
    run,
  })

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
        onRerun={rerun}
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

  // Built-in viz components compute in-browser from all rows; gated in server mode
  // until each has a server-side aggregation endpoint (same as analysis viz).
  if (isServerMode()) {
    return (
      <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
        {t('datasets.component_server_unavailable')}
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      {/* eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data */}
      <Component config={source.config} columns={columns} rows={filteredRows} compact />
    </div>
  )
}
