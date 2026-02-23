import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { DashboardWidget } from '@/types'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import { useDashboardData } from '../DashboardDataProvider'
import { PluginOutputRenderer } from '@/features/projects/lab/datasets/analyses/PluginOutputRenderer'

interface InlineCodeWidgetRendererProps {
  widget: DashboardWidget
}

export function InlineCodeWidgetRenderer({ widget }: InlineCodeWidgetRendererProps) {
  if (widget.source.type !== 'inline') return null

  return <InlineCodeExecutor widget={widget} />
}

function InlineCodeExecutor({ widget }: { widget: DashboardWidget }) {
  const { t } = useTranslation()
  const { filteredRows, columns } = useDashboardData()
  const [result, setResult] = useState<RuntimeOutput | null>(null)
  const [loading, setLoading] = useState(false)
  const [runCount, setRunCount] = useState(0)

  const source = widget.source as { type: 'inline'; language: string; code: string; config: Record<string, unknown> }

  const execute = useCallback(async () => {
    if (!source.code.trim()) {
      setResult({ stdout: 'No code to execute', stderr: '', figures: [], table: null, html: null })
      return
    }

    if (columns.length === 0) return

    setLoading(true)
    setResult(null)

    try {
      const executor = await import('@/features/projects/lab/datasets/analysis-executor')
      const exec = source.language === 'r' ? executor.executeAnalysisCodeR : executor.executeAnalysisCode
      const output = await exec(source.code, filteredRows, columns)
      setResult(output)
    } catch (err) {
      setResult({ stdout: '', stderr: String(err), figures: [], table: null, html: null })
    } finally {
      setLoading(false)
    }
  }, [filteredRows, columns, source.code, source.language])

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
      />
    </div>
  )
}
