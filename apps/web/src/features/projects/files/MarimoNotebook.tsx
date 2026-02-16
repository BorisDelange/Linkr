/**
 * MarimoNotebook — renders a marimo .py notebook with Pyodide execution.
 *
 * Each @app.cell becomes an editable cell with inline output.
 * Cells form a reactive DAG: running cell A auto-re-executes downstream cells.
 */
import { useRef, useEffect, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Play, Plus, Trash2, GripVertical, ChevronUp, ChevronDown,
  RotateCcw, Loader2, CheckCircle2, XCircle, AlertTriangle, Circle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { parseMarimoFile, serializeMarimoFile, extractReturnVars, recomputeAllParams, type MarimoCell } from '@/lib/marimo-parser'
import { PyodideCellExecutor, type CellResult } from '@/lib/cell-executor'
import { type CellStatus, getExecutionOrder, getDownstreamCells, detectCycle } from '@/lib/marimo-dag'

interface MarimoNotebookProps {
  /** Raw .py file content */
  content: string
  /** Called when the user modifies cells (serialized back to .py format) */
  onChange?: (newContent: string) => void
  /** Read-only mode */
  readOnly?: boolean
  /** Called on Cmd+S */
  onSave?: () => void
  /** Active database connection ID (for DuckDB bridge) */
  activeConnectionId?: string | null
}

interface CellState {
  status: CellStatus
  result: CellResult | null
}

export function MarimoNotebook({ content, onChange, readOnly, onSave, activeConnectionId }: MarimoNotebookProps) {
  const { t } = useTranslation()
  const [cells, setCells] = useState<MarimoCell[]>(() => parseMarimoFile(content))
  const [activeCell, setActiveCell] = useState<string | null>(null)
  const [cellStates, setCellStates] = useState<Map<string, CellState>>(new Map())
  const [cycleError, setCycleError] = useState<string | null>(null)
  const executorRef = useRef(new PyodideCellExecutor())
  // Track whether changes come from internal edits (skip re-parse)
  const internalEdit = useRef(false)
  // Guard against concurrent execution cascades
  const executingRef = useRef(false)

  // Update executor connection ID
  useEffect(() => {
    executorRef.current.setActiveConnectionId(activeConnectionId ?? null)
  }, [activeConnectionId])

  // Re-parse only when content changes externally (not from our own edits)
  useEffect(() => {
    if (internalEdit.current) {
      internalEdit.current = false
      return
    }
    setCells(parseMarimoFile(content))
  }, [content])

  // Serialize and notify parent on cell changes
  const syncToFile = useCallback((updatedCells: MarimoCell[]) => {
    if (!onChange) return
    internalEdit.current = true
    onChange(serializeMarimoFile(updatedCells))
  }, [onChange])

  // Cmd+S to save
  useEffect(() => {
    if (!onSave) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        onSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onSave])

  // Check for cycles when cells change
  useEffect(() => {
    const cycle = detectCycle(cells)
    setCycleError(cycle ? t('files.marimo_cycle_error') + ': ' + cycle.join(' → ') : null)
  }, [cells, t])

  // --- Execution ---

  const updateCellState = useCallback((cellId: string, update: Partial<CellState>) => {
    setCellStates((prev) => {
      const next = new Map(prev)
      const current = next.get(cellId) ?? { status: 'idle' as CellStatus, result: null }
      next.set(cellId, { ...current, ...update })
      return next
    })
  }, [])

  const executeCell = useCallback(async (cellId: string, currentCells: MarimoCell[]) => {
    const cell = currentCells.find((c) => c.id === cellId)
    if (!cell) return

    updateCellState(cellId, { status: 'running' })

    const result = await executorRef.current.execute(cell.code, cellId)
    updateCellState(cellId, {
      status: result.success ? 'success' : 'error',
      result,
    })

    return result
  }, [updateCellState])

  const runCell = useCallback(async (cellId: string) => {
    if (executingRef.current) return
    executingRef.current = true

    try {
      // Use latest cells from state
      const currentCells = cells
      const result = await executeCell(cellId, currentCells)

      if (result?.success) {
        // Find and execute downstream cells
        const downstream = getDownstreamCells(cellId, currentCells)

        // Mark downstream as stale first
        for (const depId of downstream) {
          updateCellState(depId, { status: 'stale' })
        }

        // Execute downstream in order
        for (const depId of downstream) {
          await executeCell(depId, currentCells)
        }
      }
    } finally {
      executingRef.current = false
    }
  }, [cells, executeCell, updateCellState])

  const runAll = useCallback(async () => {
    if (executingRef.current) return
    executingRef.current = true

    try {
      await executorRef.current.reset()

      // Clear all states
      setCellStates(new Map())

      let order: string[]
      try {
        order = getExecutionOrder(cells)
      } catch (err) {
        setCycleError(err instanceof Error ? err.message : String(err))
        return
      }

      for (const cellId of order) {
        await executeCell(cellId, cells)
      }
    } finally {
      executingRef.current = false
    }
  }, [cells, executeCell])

  // --- Cell operations ---

  const updateCellCode = useCallback((cellId: string, newCode: string) => {
    setCells((prev) => {
      const updated = prev.map((c) => {
        if (c.id !== cellId) return c
        // Auto-update exports from the code
        const exports = extractReturnVars(newCode)
        return { ...c, code: newCode, exports }
      })
      // Recompute params for all cells (a new export may be consumed elsewhere)
      const next = recomputeAllParams(updated)
      syncToFile(next)
      return next
    })
  }, [syncToFile])

  const addCell = useCallback((afterId?: string) => {
    setCells((prev) => {
      const newCell: MarimoCell = {
        id: `marimo-cell-${Date.now()}`,
        name: '_',
        code: '',
        params: [],
        exports: [],
      }
      if (!afterId) {
        const next = [...prev, newCell]
        syncToFile(next)
        return next
      }
      const idx = prev.findIndex((c) => c.id === afterId)
      const next = [...prev]
      next.splice(idx + 1, 0, newCell)
      syncToFile(next)
      return next
    })
  }, [syncToFile])

  const removeCell = useCallback((cellId: string) => {
    setCells((prev) => {
      const filtered = prev.filter((c) => c.id !== cellId)
      // Recompute params since an export source may have been removed
      const next = recomputeAllParams(filtered)
      syncToFile(next)
      return next
    })
    setCellStates((prev) => {
      const next = new Map(prev)
      next.delete(cellId)
      return next
    })
  }, [syncToFile])

  const moveCell = useCallback((cellId: string, direction: 'up' | 'down') => {
    setCells((prev) => {
      const idx = prev.findIndex((c) => c.id === cellId)
      if (idx === -1) return prev
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1
      if (targetIdx < 0 || targetIdx >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(idx, 1)
      next.splice(targetIdx, 0, moved)
      syncToFile(next)
      return next
    })
  }, [syncToFile])

  // Drag-and-drop reordering
  const [dragCellId, setDragCellId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const handleDragStart = useCallback((cellId: string, e: React.DragEvent) => {
    setDragCellId(cellId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('marimo-cell-id', cellId)
  }, [])

  const handleDragOver = useCallback((cellId: string, e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('marimo-cell-id')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTargetId(cellId)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDropTargetId(null)
  }, [])

  const handleDrop = useCallback((targetCellId: string, e: React.DragEvent) => {
    e.preventDefault()
    const sourceCellId = e.dataTransfer.getData('marimo-cell-id')
    if (!sourceCellId || sourceCellId === targetCellId) {
      setDragCellId(null)
      setDropTargetId(null)
      return
    }
    setCells((prev) => {
      const fromIdx = prev.findIndex((c) => c.id === sourceCellId)
      const toIdx = prev.findIndex((c) => c.id === targetCellId)
      if (fromIdx === -1 || toIdx === -1) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      syncToFile(next)
      return next
    })
    setDragCellId(null)
    setDropTargetId(null)
  }, [syncToFile])

  const handleDragEnd = useCallback(() => {
    setDragCellId(null)
    setDropTargetId(null)
  }, [])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5 shrink-0">
        <span className="text-xs font-medium">{t('files.marimo_notebook')}</span>
        <span className="text-[10px] text-muted-foreground">
          {cells.length} {cells.length === 1 ? 'cell' : 'cells'}
        </span>
        {cycleError && (
          <span className="text-[10px] text-destructive flex items-center gap-1">
            <AlertTriangle size={10} />
            {cycleError}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={runAll}
            disabled={executingRef.current}
          >
            <RotateCcw size={12} />
            {t('files.marimo_run_all')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={async () => {
              await executorRef.current.reset()
              setCellStates(new Map())
            }}
            title={t('files.marimo_reset')}
          >
            {t('files.marimo_reset')}
          </Button>
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => addCell()}
            >
              <Plus size={12} />
              {t('files.marimo_add_cell')}
            </Button>
          )}
        </div>
      </div>

      {/* Cells */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {cells.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-sm text-muted-foreground">{t('files.marimo_empty')}</p>
            {!readOnly && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => addCell()}
              >
                <Plus size={14} />
                {t('files.marimo_add_cell')}
              </Button>
            )}
          </div>
        ) : (
          cells.map((cell, idx) => (
            <CellBlock
              key={cell.id}
              cell={cell}
              index={idx}
              isActive={activeCell === cell.id}
              isFirst={idx === 0}
              isLast={idx === cells.length - 1}
              readOnly={readOnly}
              cellState={cellStates.get(cell.id)}
              isDragging={dragCellId === cell.id}
              isDropTarget={dropTargetId === cell.id}
              onFocus={() => setActiveCell(cell.id)}
              onCodeChange={(code) => updateCellCode(cell.id, code)}
              onRun={() => runCell(cell.id)}
              onRunAll={runAll}
              onAddBelow={() => addCell(cell.id)}
              onRemove={() => removeCell(cell.id)}
              onMoveUp={() => moveCell(cell.id, 'up')}
              onMoveDown={() => moveCell(cell.id, 'down')}
              onDragStart={(e) => handleDragStart(cell.id, e)}
              onDragOver={(e) => handleDragOver(cell.id, e)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(cell.id, e)}
              onDragEnd={handleDragEnd}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CellBlock — individual cell with code editor and inline output
// ---------------------------------------------------------------------------

interface CellBlockProps {
  cell: MarimoCell
  index: number
  isActive: boolean
  isFirst: boolean
  isLast: boolean
  readOnly?: boolean
  cellState?: CellState
  isDragging: boolean
  isDropTarget: boolean
  onFocus: () => void
  onCodeChange: (code: string) => void
  onRun: () => void
  onRunAll: () => void
  onAddBelow: () => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

function CellBlock({
  cell,
  index,
  isActive,
  isFirst,
  isLast,
  readOnly,
  cellState,
  isDragging,
  isDropTarget,
  onFocus,
  onCodeChange,
  onRun,
  onRunAll,
  onAddBelow,
  onRemove,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: CellBlockProps) {
  const { t } = useTranslation()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const status = cellState?.status ?? 'idle'
  const result = cellState?.result ?? null

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [cell.code])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab inserts 4 spaces
    if (e.key === 'Tab') {
      e.preventDefault()
      const el = e.currentTarget
      const start = el.selectionStart
      const end = el.selectionEnd
      const value = el.value
      const newValue = value.substring(0, start) + '    ' + value.substring(end)
      onCodeChange(newValue)
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 4
      })
    }
    // Cmd/Ctrl+Shift+Enter → run all cells
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault()
      onRunAll()
      return
    }
    // Cmd/Ctrl+Enter or Shift+Enter → run this cell
    if (e.key === 'Enter' && ((e.metaKey || e.ctrlKey) || e.shiftKey)) {
      e.preventDefault()
      onRun()
    }
  }, [onCodeChange, onRun, onRunAll])

  const gripRef = useRef<HTMLDivElement>(null)

  // Only allow drag when initiated from the grip handle
  const handleCellDragStart = useCallback((e: React.DragEvent) => {
    if (!gripRef.current?.contains(e.target as Node)) {
      e.preventDefault()
      return
    }
    onDragStart(e)
  }, [onDragStart])

  return (
    <div
      draggable={!readOnly}
      onDragStart={handleCellDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={cn(
        'group rounded-md border transition-colors',
        isActive ? 'border-primary/50 bg-primary/5' : 'border-border hover:border-primary/30',
        isDragging && 'opacity-40',
        isDropTarget && 'border-primary border-2 bg-primary/10',
      )}
    >
      {/* Cell header */}
      <div className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground">
        <div ref={gripRef} className="opacity-0 group-hover:opacity-50 cursor-grab active:cursor-grabbing">
          <GripVertical size={10} />
        </div>
        <span className="tabular-nums">
          [{index + 1}]
        </span>
        {cell.name !== '_' && (
          <span className="font-medium text-foreground/70">{cell.name}</span>
        )}
        <StatusDot status={status} />
        {cell.params.length > 0 && (
          <span className="text-muted-foreground/60">
            ({cell.params.join(', ')})
          </span>
        )}
        {cell.exports.length > 0 && (
          <span className="text-muted-foreground/60">
            → {cell.exports.join(', ')}
          </span>
        )}
        {!readOnly && (
          <TooltipProvider delayDuration={300}>
            <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onRun}
                    className="rounded p-0.5 hover:bg-accent text-green-600"
                  >
                    <Play size={12} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {t('files.marimo_run_cell')} (⌘↵)
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onMoveUp}
                    disabled={isFirst}
                    className="rounded p-0.5 hover:bg-accent disabled:opacity-25"
                  >
                    <ChevronUp size={12} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {t('common.move_up', 'Move up')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onMoveDown}
                    disabled={isLast}
                    className="rounded p-0.5 hover:bg-accent disabled:opacity-25"
                  >
                    <ChevronDown size={12} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {t('common.move_down', 'Move down')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onAddBelow}
                    className="rounded p-0.5 hover:bg-accent"
                  >
                    <Plus size={12} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {t('files.marimo_add_cell')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onRemove}
                    className="rounded p-0.5 hover:bg-destructive/20 text-destructive"
                  >
                    <Trash2 size={12} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {t('common.delete', 'Delete')}
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        )}
      </div>

      {/* Code textarea */}
      <div className="px-2 pb-1">
        <textarea
          ref={textareaRef}
          value={cell.code}
          onChange={(e) => onCodeChange(e.target.value)}
          onFocus={onFocus}
          onKeyDown={handleKeyDown}
          readOnly={readOnly}
          spellCheck={false}
          className={cn(
            'w-full resize-none rounded border-0 bg-background p-2 font-mono text-xs leading-relaxed outline-none',
            'focus:ring-1 focus:ring-primary/30',
            readOnly && 'cursor-default',
          )}
          rows={1}
          placeholder="# Python code..."
        />
      </div>

      {/* Inline output */}
      {result && <CellOutput result={result} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// StatusDot — colored status indicator
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: CellStatus }) {
  switch (status) {
    case 'idle':
      return <Circle size={8} className="text-muted-foreground/30" />
    case 'queued':
      return <Circle size={8} className="text-blue-400 animate-pulse" />
    case 'running':
      return <Loader2 size={10} className="text-blue-500 animate-spin" />
    case 'success':
      return <CheckCircle2 size={10} className="text-green-500" />
    case 'error':
      return <XCircle size={10} className="text-red-500" />
    case 'stale':
      return <AlertTriangle size={10} className="text-orange-400" />
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// CellOutput — inline output below a cell (stdout, error, figures, tables)
// ---------------------------------------------------------------------------

function CellOutput({ result }: { result: CellResult }) {
  const hasOutput = result.stdout || result.error || result.stderr ||
    (result.figures && result.figures.length > 0) ||
    result.table

  if (!hasOutput) return null

  return (
    <div className="border-t border-dashed mx-2 mb-2 pt-1 space-y-1">
      {/* stdout */}
      {result.stdout && (
        <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground px-2 py-1 bg-muted/30 rounded max-h-48 overflow-y-auto">
          {result.stdout}
        </pre>
      )}

      {/* error / stderr */}
      {(result.error || result.stderr) && (
        <pre className="text-xs font-mono whitespace-pre-wrap text-red-600 dark:text-red-400 px-2 py-1 bg-red-500/5 rounded max-h-48 overflow-y-auto">
          {result.error || result.stderr}
        </pre>
      )}

      {/* Matplotlib figures (SVG) */}
      {result.figures?.map((fig, i) => (
        <div
          key={i}
          className="bg-white dark:bg-zinc-900 rounded p-2 flex justify-center max-h-80 overflow-auto"
          dangerouslySetInnerHTML={{ __html: fig.data }}
        />
      ))}

      {/* DataFrame table preview */}
      {result.table && (
        <div className="max-h-64 overflow-auto rounded border">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="px-2 py-1 text-left text-muted-foreground font-medium border-b">#</th>
                {result.table.headers.map((h, i) => (
                  <th key={i} className="px-2 py-1 text-left font-medium border-b">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.table.rows.slice(0, 20).map((row, ri) => (
                <tr key={ri} className="border-b border-border/50 hover:bg-accent/30">
                  <td className="px-2 py-0.5 text-muted-foreground/50">{ri + 1}</td>
                  {row.map((val, ci) => (
                    <td key={ci} className="px-2 py-0.5">{val}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {result.table.rows.length > 20 && (
            <div className="px-2 py-1 text-[10px] text-muted-foreground bg-muted/30 border-t">
              {result.table.rows.length} rows total (showing first 20)
            </div>
          )}
        </div>
      )}
    </div>
  )
}
