/**
 * MarimoNotebook — renders a marimo .py notebook using @marimo-team/islands.
 *
 * The marimo islands runtime is loaded via CDN into an iframe for isolation.
 * Each @app.cell function becomes a <marimo-island> custom element.
 * Cells are editable and reactive — changes sync back to the file store.
 */
import { useMemo, useRef, useEffect, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Plus, Trash2, GripVertical, ChevronUp, ChevronDown, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { parseMarimoFile, serializeMarimoFile, type MarimoCell } from '@/lib/marimo-parser'

const ISLANDS_VERSION = '0.19.11'
const ISLANDS_JS = `https://cdn.jsdelivr.net/npm/@marimo-team/islands@${ISLANDS_VERSION}/dist/main.js`
const ISLANDS_CSS = `https://cdn.jsdelivr.net/npm/@marimo-team/islands@${ISLANDS_VERSION}/dist/style.css`

interface MarimoNotebookProps {
  /** Raw .py file content */
  content: string
  /** Called when the user modifies cells (serialized back to .py format) */
  onChange?: (newContent: string) => void
  /** Read-only mode */
  readOnly?: boolean
  /** Called on Cmd+S */
  onSave?: () => void
}

export function MarimoNotebook({ content, onChange, readOnly, onSave }: MarimoNotebookProps) {
  const { t } = useTranslation()
  const [cells, setCells] = useState<MarimoCell[]>(() => parseMarimoFile(content))
  const [activeCell, setActiveCell] = useState<string | null>(null)
  const [islandReady, setIslandReady] = useState(false)
  const [islandKey, setIslandKey] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Track whether changes come from internal edits (skip re-parse)
  const internalEdit = useRef(false)

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

  // Build the islands HTML for the iframe
  const islandsHtml = useMemo(() => {
    const cellsHtml = cells.map((cell, idx) => {
      const encodedCode = encodeURIComponent(cell.code)
      return `
        <marimo-island data-app-id="notebook" data-cell-id="cell-${idx}" data-reactive="true">
          <marimo-cell-output></marimo-cell-output>
          <marimo-cell-code hidden>${encodedCode}</marimo-cell-code>
        </marimo-island>`
    }).join('\n')

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <script type="module" src="${ISLANDS_JS}"></script>
  <link href="${ISLANDS_CSS}" rel="stylesheet" crossorigin="anonymous" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fira+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      background: transparent;
    }
    marimo-island {
      display: block;
      margin-bottom: 8px;
    }
  </style>
  <script>
    window.addEventListener('marimo:ready', () => {
      window.parent.postMessage({ type: 'marimo:ready' }, '*')
    })
    setTimeout(() => {
      window.parent.postMessage({ type: 'marimo:ready' }, '*')
    }, 5000)
  </script>
</head>
<body>
${cellsHtml}
</body>
</html>`
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only rebuild iframe on explicit run
  }, [islandKey])

  // Listen for messages from the iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'marimo:ready') {
        setIslandReady(true)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

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

  // Run all cells: rebuild the iframe with current cell code
  const runAll = useCallback(() => {
    setIslandReady(false)
    setIslandKey((k) => k + 1)
  }, [])

  // Cell operations
  const updateCellCode = useCallback((cellId: string, newCode: string) => {
    setCells((prev) => {
      const next = prev.map((c) => c.id === cellId ? { ...c, code: newCode } : c)
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
      const next = prev.filter((c) => c.id !== cellId)
      syncToFile(next)
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5 shrink-0">
        <span className="text-xs font-medium">{t('files.marimo_notebook')}</span>
        <span className="text-[10px] text-muted-foreground">
          {cells.length} {cells.length === 1 ? 'cell' : 'cells'}
        </span>
        {!islandReady && (
          <span className="text-[10px] text-orange-500 animate-pulse">
            {t('files.marimo_loading')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={runAll}
          >
            <RotateCcw size={12} />
            {t('files.marimo_run_all', 'Run all')}
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

      {/* Split view: cells editor (left) + islands output (right) */}
      <div className="flex flex-1 min-h-0">
        {/* Cell editor panel */}
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
                onFocus={() => setActiveCell(cell.id)}
                onCodeChange={(code) => updateCellCode(cell.id, code)}
                onRun={runAll}
                onAddBelow={() => addCell(cell.id)}
                onRemove={() => removeCell(cell.id)}
                onMoveUp={() => moveCell(cell.id, 'up')}
                onMoveDown={() => moveCell(cell.id, 'down')}
              />
            ))
          )}
        </div>

        {/* Islands output panel (iframe) */}
        <div className="w-1/2 border-l overflow-hidden">
          <iframe
            ref={iframeRef}
            key={islandKey}
            srcDoc={islandsHtml}
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-downloads allow-popups"
            title="Marimo output"
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CellBlock — individual cell in the editor panel
// ---------------------------------------------------------------------------

interface CellBlockProps {
  cell: MarimoCell
  index: number
  isActive: boolean
  isFirst: boolean
  isLast: boolean
  readOnly?: boolean
  onFocus: () => void
  onCodeChange: (code: string) => void
  onRun: () => void
  onAddBelow: () => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}

function CellBlock({
  cell,
  index,
  isActive,
  isFirst,
  isLast,
  readOnly,
  onFocus,
  onCodeChange,
  onRun,
  onAddBelow,
  onRemove,
  onMoveUp,
  onMoveDown,
}: CellBlockProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
    // Shift+Enter runs all cells
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      onRun()
    }
  }, [onCodeChange, onRun])

  return (
    <div
      className={cn(
        'group rounded-md border transition-colors',
        isActive ? 'border-primary/50 bg-primary/5' : 'border-border hover:border-primary/30',
      )}
    >
      {/* Cell header */}
      <div className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground">
        <GripVertical size={10} className="opacity-0 group-hover:opacity-50 cursor-grab" />
        <span className="tabular-nums">
          [{index + 1}]
        </span>
        {cell.name !== '_' && (
          <span className="font-medium text-foreground/70">{cell.name}</span>
        )}
        {!readOnly && (
          <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={onRun}
              className="rounded p-0.5 hover:bg-accent text-green-600"
              title="Run all (Shift+Enter)"
            >
              <Play size={12} />
            </button>
            <button
              onClick={onMoveUp}
              disabled={isFirst}
              className="rounded p-0.5 hover:bg-accent disabled:opacity-25"
            >
              <ChevronUp size={12} />
            </button>
            <button
              onClick={onMoveDown}
              disabled={isLast}
              className="rounded p-0.5 hover:bg-accent disabled:opacity-25"
            >
              <ChevronDown size={12} />
            </button>
            <button
              onClick={onAddBelow}
              className="rounded p-0.5 hover:bg-accent"
              title="Add cell below"
            >
              <Plus size={12} />
            </button>
            <button
              onClick={onRemove}
              className="rounded p-0.5 hover:bg-destructive/20 text-destructive"
              title="Delete cell"
            >
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>

      {/* Code textarea */}
      <div className="px-2 pb-2">
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
    </div>
  )
}
