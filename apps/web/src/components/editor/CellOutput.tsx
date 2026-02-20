/**
 * Shared cell output renderer.
 * Displays RuntimeOutput (stdout, stderr, figures, table) inline below a cell.
 * Used by both IpynbViewer and RmdNotebook.
 */

import { useState, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronsUpDown, Maximize2, ZoomIn, ZoomOut, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { RuntimeOutput } from '@/lib/runtimes/types'

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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{output.html}</ReactMarkdown>
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

const ZOOM_MIN = 0.25
const ZOOM_MAX = 5
const ZOOM_STEP = 0.25
const ZOOM_WHEEL_STEP = 0.15

function FigureOutput({ fig }: { fig: { type: string; data: string; label: string } }) {
  const [open, setOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const isPanning = useRef(false)
  const panStart = useRef({ x: 0, y: 0 })

  const resetView = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const clampZoom = useCallback((z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)), [])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setZoom((z) => clampZoom(z + (e.deltaY < 0 ? ZOOM_WHEEL_STEP : -ZOOM_WHEEL_STEP)))
  }, [clampZoom])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    isPanning.current = true
    panStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [pan])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return
    setPan({ x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y })
  }, [])

  const handlePointerUp = useCallback(() => {
    isPanning.current = false
  }, [])

  return (
    <>
      <div className="relative group/fig bg-white dark:bg-zinc-900 rounded p-2 flex justify-center">
        {fig.type === 'svg' ? (
          <div
            className="cursor-pointer [&>svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: fig.data }}
            onClick={() => { resetView(); setOpen(true) }}
          />
        ) : (
          <img
            src={fig.data}
            alt={fig.label}
            className="max-w-full max-h-full object-contain cursor-pointer"
            onClick={() => { resetView(); setOpen(true) }}
          />
        )}
        <button
          onClick={() => { resetView(); setOpen(true) }}
          className="absolute top-2 right-2 p-1 rounded bg-muted/80 border border-border/50 text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent opacity-0 group-hover/fig:opacity-100 transition-opacity"
          title="Enlarge"
        >
          <Maximize2 size={12} />
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="max-w-[98vw] sm:max-w-[98vw] max-h-[98vh] w-[98vw] h-[98vh] p-0 overflow-hidden flex flex-col gap-0">
          {/* Toolbar */}
          <div className="flex items-center px-3 py-1.5 border-b bg-muted/30 shrink-0">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
                disabled={zoom <= ZOOM_MIN}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30"
                title="Zoom out"
              >
                <ZoomOut size={14} />
              </button>
              <span className="text-[10px] text-muted-foreground w-8 text-center tabular-nums">
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
                disabled={zoom >= ZOOM_MAX}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30"
                title="Zoom in"
              >
                <ZoomIn size={14} />
              </button>
              <button
                onClick={resetView}
                className="px-2 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title="Reset zoom"
              >
                Reset
              </button>
            </div>
            <div className="flex-1" />
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title="Close"
            >
              <X size={14} />
            </button>
          </div>

          {/* Zoomable image area */}
          <div
            className="flex-1 min-h-0 overflow-hidden cursor-grab active:cursor-grabbing select-none"
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            <div
              className="w-full h-full flex items-center justify-center"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: 'center center',
              }}
            >
              {fig.type === 'svg' ? (
                <div
                  className="[&>svg]:max-w-full [&>svg]:max-h-[calc(98vh-3rem)] [&>svg]:object-contain pointer-events-none"
                  dangerouslySetInnerHTML={{ __html: fig.data }}
                />
              ) : (
                <img
                  src={fig.data}
                  alt={fig.label}
                  className="max-w-full max-h-[calc(98vh-3rem)] object-contain pointer-events-none"
                  draggable={false}
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Collapsible <pre> for long text outputs
// ---------------------------------------------------------------------------

function CollapsiblePre({ children, className }: { children?: string; className?: string }) {
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
}

// ---------------------------------------------------------------------------
// Collapsible table for DataFrame outputs
// ---------------------------------------------------------------------------

const TABLE_COLLAPSED_ROWS = 10

function CollapsibleTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
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
}
