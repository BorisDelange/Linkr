import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { DashboardWidget } from '@/types'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import { useDashboardData } from '../DashboardDataProvider'
import { resolveServerFilters } from '../resolve-server-filters'
import { useWidgetExecution } from './use-widget-execution'
import { PluginOutputRenderer } from '@/features/projects/lab/datasets/analyses/PluginOutputRenderer'
import { isServerMode } from '@/lib/api-client'
import { executeOnServer } from '@/lib/api/execution'
import { useAppStore } from '@/stores/app-store'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { ExecuteNotPermitted } from '@/components/ui/execute-not-permitted'

interface InlineCodeWidgetRendererProps {
  widget: DashboardWidget
}

export function InlineCodeWidgetRenderer({ widget }: InlineCodeWidgetRendererProps) {
  if (widget.source.type !== 'inline') return null

  return <InlineCodeExecutor widget={widget} />
}

function InlineCodeExecutor({ widget }: { widget: DashboardWidget }) {
  const { t } = useTranslation()
  const { filteredRows, columns, reloadOnTabSwitch, dataSignature, datasetFileId, filters } = useDashboardData()
  const activeProjectUid = useAppStore((s) => s.activeProjectUid)
  const canExecute = useMyProjectRole(activeProjectUid ?? undefined).can('dashboards:execute')

  const source = widget.source as { type: 'inline'; language: string; code: string; config: Record<string, unknown> }

  const run = async (): Promise<RuntimeOutput> => {
    if (!source.code.trim()) {
      return { stdout: 'No code to execute', stderr: '', figures: [], table: null, html: null }
    }
    try {
      const language = source.language === 'r' ? 'r' : 'python'
      if (isServerMode()) {
        // Server mode: backend loads the dataset Parquet as `dataset` and applies
        // the dashboard filters — no rows are shipped to the browser.
        return await executeOnServer(language, source.code, {
          projectUid: activeProjectUid ?? undefined,
          datasetFileId: datasetFileId ?? undefined,
          datasetFilters: datasetFileId ? resolveServerFilters(filters, columns) : undefined,
          purpose: 'dashboards',
          // Each widget run gets its own isolated process → widgets execute in parallel.
          ephemeral: true,
        })
      }
      const executor = await import('@/features/projects/lab/datasets/analysis-executor')
      const exec = source.language === 'r' ? executor.executeAnalysisCodeR : executor.executeAnalysisCode
      return await exec(source.code, filteredRows, columns)
    } catch (err) {
      return { stdout: '', stderr: String(err), figures: [], table: null, html: null }
    }
  }

  const { result, loading, rerun } = useWidgetExecution({
    widgetId: widget.id,
    signature: `${source.language}|${source.code}|${dataSignature}`,
    ready: columns.length > 0 && canExecute,
    alwaysReload: reloadOnTabSwitch,
    run,
  })

  // Read-only user: inline code widgets run R/Python they can't execute.
  if (!canExecute) return <ExecuteNotPermitted compact />

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
        showConsole={false}
      />
    </div>
  )
}
