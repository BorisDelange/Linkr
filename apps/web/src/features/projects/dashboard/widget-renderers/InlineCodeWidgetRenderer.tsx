import { useState, useEffect } from 'react'
import type { DashboardWidget } from '@/types'
import { useDashboardData } from '../DashboardDataProvider'
import { Loader2 } from 'lucide-react'

interface InlineCodeWidgetRendererProps {
  widget: DashboardWidget
}

export function InlineCodeWidgetRenderer({ widget }: InlineCodeWidgetRendererProps) {
  if (widget.source.type !== 'inline') return null

  return <InlineCodeExecutor widget={widget} />
}

function InlineCodeExecutor({ widget }: { widget: DashboardWidget }) {
  const { filteredRows, columns } = useDashboardData()
  const [output, setOutput] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const source = widget.source as { type: 'inline'; language: string; code: string; config: Record<string, unknown> }

  useEffect(() => {
    if (!source.code.trim()) {
      setOutput('No code to execute')
      return
    }

    if (filteredRows.length === 0) {
      setOutput('No data available')
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    import('@/features/projects/lab/datasets/analysis-executor').then(async (executor) => {
      try {
        const result = await executor.executeAnalysisCode(
          source.code,
          filteredRows,
          columns,
        )
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
  }, [filteredRows, columns, source.code, source.language])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={16} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

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
