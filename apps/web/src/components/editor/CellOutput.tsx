/**
 * Shared cell output renderer.
 * Displays RuntimeOutput (stdout, stderr, figures, table) inline below a cell.
 * Used by both IpynbViewer and RmdNotebook.
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { RuntimeOutput } from '@/lib/runtimes/types'

interface CellOutputProps {
  output: RuntimeOutput
}

export function CellOutput({ output }: CellOutputProps) {
  const hasOutput =
    output.stdout ||
    output.stderr ||
    output.html ||
    output.figures.length > 0 ||
    output.table

  if (!hasOutput) return null

  return (
    <div className="border-t border-dashed mx-2 mb-2 pt-1 space-y-1">
      {/* HTML / markdown output */}
      {output.html && (
        <div className="px-2 py-1 prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{output.html}</ReactMarkdown>
        </div>
      )}

      {/* stdout */}
      {output.stdout && (
        <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground px-2 py-1 bg-muted/30 rounded max-h-48 overflow-y-auto">
          {output.stdout}
        </pre>
      )}

      {/* stderr */}
      {output.stderr && (
        <pre className="text-xs font-mono whitespace-pre-wrap text-red-600 dark:text-red-400 px-2 py-1 bg-red-500/5 rounded max-h-48 overflow-y-auto">
          {output.stderr}
        </pre>
      )}

      {/* Figures (SVG or PNG data URI) */}
      {output.figures.map((fig) => (
        <div
          key={fig.id}
          className="bg-white dark:bg-zinc-900 rounded p-2 flex justify-center max-h-80 overflow-auto"
        >
          {fig.type === 'svg' ? (
            <div dangerouslySetInnerHTML={{ __html: fig.data }} />
          ) : (
            <img
              src={fig.data}
              alt={fig.label}
              className="max-w-full max-h-full object-contain"
            />
          )}
        </div>
      ))}

      {/* DataFrame table preview */}
      {output.table && (
        <div className="max-h-64 overflow-auto rounded border">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="px-2 py-1 text-left text-muted-foreground font-medium border-b">
                  #
                </th>
                {output.table.headers.map((h, i) => (
                  <th
                    key={i}
                    className="px-2 py-1 text-left font-medium border-b"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {output.table.rows.slice(0, 20).map((row, ri) => (
                <tr
                  key={ri}
                  className="border-b border-border/50 hover:bg-accent/30"
                >
                  <td className="px-2 py-0.5 text-muted-foreground/50">
                    {ri + 1}
                  </td>
                  {row.map((val, ci) => (
                    <td key={ci} className="px-2 py-0.5">
                      {val}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {output.table.rows.length > 20 && (
            <div className="px-2 py-1 text-[10px] text-muted-foreground bg-muted/30 border-t">
              {output.table.rows.length} rows total (showing first 20)
            </div>
          )}
        </div>
      )}
    </div>
  )
}
