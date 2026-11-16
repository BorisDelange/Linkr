import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CodeViewer } from '@/components/editor/CodeViewer'
import { stripAnsi } from '@/lib/ansi'
import { sanitizeHtml } from '@/lib/sanitize'
import { cn } from '@/lib/utils'
import type { Job } from '@/lib/api/environments'

export function NoLog() {
  const { t } = useTranslation()
  return <p className="rounded bg-muted/60 p-3 text-xs text-muted-foreground">{t('jobs.no_log')}</p>
}

/** A job's captured log in the read-only editor. Monaco renders no SGR sequences,
 *  so ANSI is stripped rather than shown raw; 'shell' highlights the `$ …` command
 *  lines the build/install steps echo. */
export function JobLogView({ text, height }: { text: string; height: string | number }) {
  const plain = useMemo(() => stripAnsi(text), [text])
  return (
    <div className={cn('overflow-hidden rounded border', height === '100%' && 'min-h-0 flex-1')}>
      <CodeViewer value={plain} language="shell" height={height} followEnd />
    </div>
  )
}

/** Figures (inline SVG) + result table collected by a 'run' job, shown under its
 *  log. Rendered from the sanitized SVG string / JSON table the batch run produced. */
export function JobArtifacts({ result }: { result: NonNullable<Job['result']> }) {
  const { t } = useTranslation()
  const figures = result.figures ?? []
  const table = result.table
  const html = result.html
  if (figures.length === 0 && !table && !html) return null
  return (
    <div className="flex flex-col gap-3">
      {figures.map((fig, i) => (
        <div key={fig.id ?? i} className="rounded border bg-background p-2">
          {fig.label && <p className="mb-1 text-[10px] text-muted-foreground">{fig.label}</p>}
          {fig.type === 'svg' ? (
            <div className="overflow-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: sanitizeHtml(fig.data) }} />
          ) : (
            <img src={`data:image/png;base64,${fig.data}`} alt={fig.label ?? 'figure'} className="max-w-full" />
          )}
        </div>
      ))}
      {html && (
        // A widget (plotly/leaflet/DT) — self-contained HTML in a sandboxed iframe.
        // NO allow-same-origin: a srcDoc iframe inherits our origin, and combining it
        // with allow-scripts would let untrusted widget JS reach the parent origin
        // (cookies/session/DOM). Plotly/leaflet/DT run fine on allow-scripts alone.
        <iframe
          srcDoc={html}
          className="h-[60vh] w-full rounded border"
          sandbox="allow-scripts"
          title="widget"
        />
      )}
      {table && (
        <div className="overflow-auto rounded border">
          <table className="w-full text-xs">
            <thead className="bg-muted/60">
              <tr>
                {table.headers.map((h, i) => (
                  <th key={i} className="border-b px-2 py-1 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(0, 200).map((row, ri) => (
                <tr key={ri} className="odd:bg-muted/20">
                  {row.map((cell, ci) => (
                    <td key={ci} className="border-b px-2 py-1">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {table.rows.length > 200 && (
            <p className="px-2 py-1 text-[10px] text-muted-foreground">
              {t('jobs.table_truncated', { shown: 200, total: table.rows.length })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
