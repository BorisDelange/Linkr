/**
 * Shared cell output renderer.
 * Displays RuntimeOutput (stdout, stderr, figures, table) inline below a cell.
 * Used by both IpynbViewer and RmdNotebook.
 */

import { useState, memo } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronsUpDown, Maximize2 } from 'lucide-react'
import { ImageLightbox } from '@/components/ImageLightbox'
import { markdownComponents } from '@/components/editor/markdown-components'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import { sanitizeHtml } from '@/lib/sanitize'

const COLLAPSE_LINE_THRESHOLD = 30
const COLLAPSED_LINES = 15

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
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{output.html}</ReactMarkdown>
        </div>
      )}

      {/* stdout */}
      {output.stdout && (
        <CollapsiblePre className="text-muted-foreground bg-muted/30">
          {output.stdout}
        </CollapsiblePre>
      )}

      {/* stderr */}
      {output.stderr && (
        <CollapsiblePre className="text-red-600 dark:text-red-400 bg-red-500/5">
          {output.stderr}
        </CollapsiblePre>
      )}

      {/* Figures (SVG or PNG data URI) */}
      {output.figures.map((fig) => (
        <FigureOutput key={fig.id} fig={fig} />
      ))}

      {/* DataFrame table preview */}
      {output.table && (
        <CollapsibleTable
          headers={output.table.headers}
          rows={output.table.rows}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Figure output with zoomable lightbox
// ---------------------------------------------------------------------------

const FigureOutput = memo(function FigureOutput({ fig }: { fig: { type: string; data: string; label: string } }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <>
      <div className="relative group/fig bg-white rounded p-2 flex justify-center dark:invert dark:hue-rotate-180">
        {fig.type === 'svg' ? (
          <div
            className="cursor-zoom-in [&>svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(fig.data) }}
            onClick={() => setOpen(true)}
          />
        ) : (
          <img
            src={fig.data}
            alt={fig.label}
            className="max-w-full max-h-full object-contain cursor-zoom-in"
            onClick={() => setOpen(true)}
          />
        )}
        <button
          onClick={() => setOpen(true)}
          className="absolute top-2 right-2 p-1 rounded bg-muted/80 border border-border/50 text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent opacity-0 group-hover/fig:opacity-100 transition-opacity dark:invert dark:hue-rotate-180"
          title={t('common.enlarge')}
        >
          <Maximize2 size={12} />
        </button>
      </div>

      <ImageLightbox open={open} onOpenChange={setOpen} label={fig.label}>
        {fig.type === 'svg' ? (
          <div
            className="[&>svg]:max-w-full [&>svg]:max-h-full [&>svg]:object-contain pointer-events-none dark:invert dark:hue-rotate-180"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(fig.data) }}
          />
        ) : (
          <img
            src={fig.data}
            alt={fig.label}
            className="max-w-full max-h-full object-contain pointer-events-none dark:invert dark:hue-rotate-180"
            draggable={false}
          />
        )}
      </ImageLightbox>
    </>
  )
})

// ---------------------------------------------------------------------------
// Collapsible <pre> for long text outputs
// ---------------------------------------------------------------------------

const CollapsiblePre = memo(function CollapsiblePre({ children, className }: { children?: string; className?: string }) {
  const text = children ?? ''
  const lineCount = text.split('\n').length
  const isLong = lineCount > COLLAPSE_LINE_THRESHOLD
  const [collapsed, setCollapsed] = useState(isLong)

  const displayText = collapsed
    ? text.split('\n').slice(0, COLLAPSED_LINES).join('\n')
    : text

  return (
    <div className="relative group/pre">
      {isLong && (
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="absolute top-1 right-1 z-10 p-1 rounded bg-muted/80 border border-border/50 text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent opacity-0 group-hover/pre:opacity-100 transition-opacity"
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <ChevronsUpDown size={12} />
        </button>
      )}
      <pre className={`text-xs font-mono whitespace-pre-wrap px-2 py-1 rounded ${className ?? ''}`}>
        {displayText}
      </pre>
      {isLong && (
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center justify-center gap-1 w-full py-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent/30 transition-colors border-t border-dashed"
        >
          <ChevronsUpDown size={10} />
          {collapsed ? `Show all (${lineCount} lines)` : 'Collapse'}
        </button>
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Collapsible table for DataFrame outputs
// ---------------------------------------------------------------------------

const TABLE_COLLAPSED_ROWS = 10

const CollapsibleTable = memo(function CollapsibleTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const isLong = rows.length > TABLE_COLLAPSED_ROWS
  const [collapsed, setCollapsed] = useState(isLong)
  const displayRows = collapsed ? rows.slice(0, TABLE_COLLAPSED_ROWS) : rows.slice(0, 100)

  return (
    <div className="relative group/table">
      {isLong && (
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="absolute top-1 right-1 z-10 p-1 rounded bg-muted/80 border border-border/50 text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent opacity-0 group-hover/table:opacity-100 transition-opacity"
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <ChevronsUpDown size={12} />
        </button>
      )}
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 bg-muted">
            <tr>
              <th className="px-2 py-1 text-left text-muted-foreground font-medium border-b">
                #
              </th>
              {headers.map((h, i) => (
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
            {displayRows.map((row, ri) => (
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
      </div>
      {isLong && (
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center justify-center gap-1 w-full py-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent/30 transition-colors border-t border-dashed"
        >
          <ChevronsUpDown size={10} />
          {collapsed ? `Show all (${rows.length} rows)` : 'Collapse'}
        </button>
      )}
    </div>
  )
})
