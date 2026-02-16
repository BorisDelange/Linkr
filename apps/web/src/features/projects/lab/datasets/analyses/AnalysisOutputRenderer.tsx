import { useTranslation } from 'react-i18next'
import { AlertCircle, Play } from 'lucide-react'
import { OutputTable } from '@/features/projects/files/OutputTable'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { RuntimeOutput } from '@/lib/runtimes/types'

interface AnalysisOutputRendererProps {
  result: RuntimeOutput | null
  isExecuting: boolean
}

export function AnalysisOutputRenderer({ result, isExecuting }: AnalysisOutputRendererProps) {
  const { t } = useTranslation()

  if (isExecuting) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center p-6">
        <div className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="mt-3 text-xs text-muted-foreground">{t('datasets.analysis_running')}</p>
      </div>
    )
  }

  if (!result) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center p-6">
        <Play size={24} className="text-muted-foreground/50" />
        <p className="mt-3 text-xs text-muted-foreground">{t('datasets.analysis_no_result')}</p>
      </div>
    )
  }

  const hasError = result.stderr.length > 0
  const hasFigures = result.figures.length > 0
  const hasTable = result.table !== null
  const hasStdout = result.stdout.length > 0

  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-3">
        {/* Errors */}
        {hasError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
            <div className="flex items-start gap-2">
              <AlertCircle size={14} className="shrink-0 text-destructive mt-0.5" />
              <pre className="text-xs text-destructive whitespace-pre-wrap break-words font-mono flex-1">
                {result.stderr}
              </pre>
            </div>
          </div>
        )}

        {/* Figures (SVG) */}
        {hasFigures && result.figures.map((fig) => (
          <div
            key={fig.id}
            className="rounded-md border bg-background overflow-hidden"
          >
            {fig.type === 'svg' ? (
              <div
                className="w-full [&>svg]:w-full [&>svg]:h-auto"
                dangerouslySetInnerHTML={{ __html: fig.data }}
              />
            ) : (
              <img src={fig.data} alt={fig.label} className="w-full" />
            )}
          </div>
        ))}

        {/* Table */}
        {hasTable && result.table && (
          <div className="rounded-md border overflow-hidden">
            <OutputTable headers={result.table.headers} rows={result.table.rows} />
          </div>
        )}

        {/* Text output (only if no table and no figures) */}
        {hasStdout && !hasTable && !hasFigures && (
          <pre className="rounded-md border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap break-words">
            {result.stdout}
          </pre>
        )}

        {/* Stdout alongside table/figures */}
        {hasStdout && (hasTable || hasFigures) && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              {t('datasets.analysis_console_output')}
            </summary>
            <pre className="mt-1 rounded-md border bg-muted/30 p-2 font-mono whitespace-pre-wrap break-words">
              {result.stdout}
            </pre>
          </details>
        )}
      </div>
    </ScrollArea>
  )
}
