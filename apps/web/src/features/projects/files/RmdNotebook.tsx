/**
 * Cell-based notebook editor for R Markdown (.Rmd) and Quarto (.qmd) files.
 *
 * Features:
 * - Monaco mini-editor per cell (auto-height, correct language)
 * - Markdown cells toggle between edit (Monaco) and preview (rendered)
 * - Code chunk execution via Pyodide (Python), webR (R), DuckDB (SQL)
 * - Inline cell outputs (stdout, stderr, figures, tables)
 * - Add / delete / move / drag-and-drop cells
 * - Lossless round-trip serialization
 */

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
} from 'react'
import { useTranslation } from 'react-i18next'
import Editor, { type OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Play,
  PlayCircle,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  GripVertical,
  Eye,
  Pencil,
  Code,
  FileText,
  Settings2,
  Loader2,
  Check,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/stores/app-store'
import { CellOutput } from '@/components/editor/CellOutput'
import { parseRmdFile, serializeRmdFile, type RmdCell } from '@/lib/rmd-parser'
import { executePython } from '@/lib/runtimes/pyodide-engine'
import { executeR } from '@/lib/runtimes/webr-engine'
import * as duckdbEngine from '@/lib/duckdb/engine'
import type { RuntimeOutput } from '@/lib/runtimes/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CellStatus = 'idle' | 'running' | 'success' | 'error'

interface CellState {
  status: CellStatus
  output: RuntimeOutput | null
}

// ---------------------------------------------------------------------------
// Monaco mini-editor options
// ---------------------------------------------------------------------------

function getMiniEditorOptions(
  readOnly: boolean,
  fontSize: number,
): Monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    readOnly,
    minimap: { enabled: false },
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    automaticLayout: true,
    folding: false,
    glyphMargin: false,
    lineDecorationsWidth: 8,
    lineNumbersMinChars: 3,
    renderLineHighlight: 'line',
    scrollbar: { vertical: 'hidden', horizontal: 'auto' },
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    padding: { top: 4, bottom: 4 },
    wordWrap: 'on',
    fontSize,
    tabSize: 2,
    contextmenu: false,
  }
}

// ---------------------------------------------------------------------------
// Language badge colors
// ---------------------------------------------------------------------------

const LANG_COLORS: Record<string, string> = {
  r: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  python: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
  sql: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  bash: 'bg-green-500/10 text-green-600 dark:text-green-400',
}

const LANG_MONACO_MAP: Record<string, string> = {
  r: 'r',
  python: 'python',
  sql: 'sql',
  bash: 'shell',
  sh: 'shell',
  julia: 'julia',
  javascript: 'javascript',
  js: 'javascript',
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface RmdNotebookProps {
  content: string
  onChange?: (newContent: string) => void
  readOnly?: boolean
  onSave?: () => void
  activeConnectionId?: string | null
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RmdNotebook({
  content,
  onChange,
  readOnly = false,
  onSave,
  activeConnectionId,
}: RmdNotebookProps) {
  const { t } = useTranslation()
  const darkMode = useAppStore((s) => s.darkMode)
  const editorTheme = useAppStore((s) => s.editorSettings.theme)
  const resolvedTheme = editorTheme === 'auto'
    ? darkMode ? 'vs-dark' : 'vs'
    : editorTheme
  const fontSize = useAppStore((s) => s.editorSettings.fontSize)

  // ---- State ----
  const [cells, setCells] = useState<RmdCell[]>(() => parseRmdFile(content))
  const [cellStates, setCellStates] = useState<Map<string, CellState>>(new Map())
  const [previewCells, setPreviewCells] = useState<Set<string>>(new Set())
  const [activeCell, setActiveCell] = useState<string | null>(null)

  // Track internal edits to avoid re-parsing when onChange is called
  const internalEdit = useRef(false)

  // Re-parse when content changes externally
  useEffect(() => {
    if (internalEdit.current) {
      internalEdit.current = false
      return
    }
    setCells(parseRmdFile(content))
  }, [content])

  // ---- Serialization ----
  const syncTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const syncToFile = useCallback(
    (updatedCells: RmdCell[]) => {
      if (!onChange) return
      if (syncTimeout.current) clearTimeout(syncTimeout.current)
      syncTimeout.current = setTimeout(() => {
        internalEdit.current = true
        onChange(serializeRmdFile(updatedCells))
      }, 300)
    },
    [onChange],
  )

  // ---- Cell operations ----
  const updateCellContent = useCallback(
    (cellId: string, newContent: string) => {
      setCells((prev) => {
        const updated = prev.map((c) =>
          c.id === cellId ? { ...c, content: newContent, dirty: true } : c,
        )
        syncToFile(updated)
        return updated
      })
    },
    [syncToFile],
  )

  const addCell = useCallback(
    (afterId: string | null, type: RmdCell['type'], language?: string) => {
      const newCell: RmdCell = {
        id: `rmd-new-${Date.now()}`,
        type,
        content: type === 'code' ? '' : '\n',
        language: type === 'code' ? (language ?? 'r') : undefined,
        dirty: true,
      }
      setCells((prev) => {
        if (afterId === null) return [...prev, newCell]
        const idx = prev.findIndex((c) => c.id === afterId)
        const updated = [...prev]
        updated.splice(idx + 1, 0, newCell)
        syncToFile(updated)
        return updated
      })
      setActiveCell(newCell.id)
    },
    [syncToFile],
  )

  const removeCell = useCallback(
    (cellId: string) => {
      setCells((prev) => {
        if (prev.length <= 1) return prev
        const updated = prev.filter((c) => c.id !== cellId)
        syncToFile(updated)
        return updated
      })
      setCellStates((prev) => {
        const next = new Map(prev)
        next.delete(cellId)
        return next
      })
    },
    [syncToFile],
  )

  const moveCell = useCallback(
    (cellId: string, direction: 'up' | 'down') => {
      setCells((prev) => {
        const idx = prev.findIndex((c) => c.id === cellId)
        if (idx < 0) return prev
        const targetIdx = direction === 'up' ? idx - 1 : idx + 1
        if (targetIdx < 0 || targetIdx >= prev.length) return prev
        const updated = [...prev]
        ;[updated[idx], updated[targetIdx]] = [updated[targetIdx], updated[idx]]
        syncToFile(updated)
        return updated
      })
    },
    [syncToFile],
  )

  // ---- Execution ----
  const runCell = useCallback(
    async (cellId: string) => {
      const cell = cells.find((c) => c.id === cellId)
      if (!cell || cell.type !== 'code' || !cell.content.trim()) return

      setCellStates((prev) => new Map(prev).set(cellId, { status: 'running', output: null }))

      try {
        let output: RuntimeOutput

        if (cell.language === 'python') {
          output = await executePython(cell.content, activeConnectionId ?? null)
        } else if (cell.language === 'r') {
          output = await executeR(cell.content, activeConnectionId ?? null)
        } else if (cell.language === 'sql') {
          if (!activeConnectionId) {
            output = {
              stdout: '',
              stderr: 'No database connection selected.',
              figures: [],
              table: null,
              html: null,
            }
          } else {
            const rows = await duckdbEngine.queryDataSource(activeConnectionId, cell.content)
            // Convert rows to table
            const headers = rows.length > 0 ? Object.keys(rows[0]) : []
            const tableRows = rows.slice(0, 1000).map((r) =>
              headers.map((h) => String(r[h] ?? '')),
            )
            output = {
              stdout: '',
              stderr: '',
              figures: [],
              table: headers.length > 0 ? { headers, rows: tableRows } : null,
              html: null,
            }
          }
        } else {
          output = {
            stdout: '',
            stderr: t('files.notebook_unsupported_language', { lang: cell.language }),
            figures: [],
            table: null,
            html: null,
          }
        }

        setCellStates((prev) => new Map(prev).set(cellId, { status: 'success', output }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setCellStates((prev) =>
          new Map(prev).set(cellId, {
            status: 'error',
            output: { stdout: '', stderr: message, figures: [], table: null, html: null },
          }),
        )
      }
    },
    [cells, activeConnectionId, t],
  )

  const runAll = useCallback(async () => {
    const codeCells = cells.filter((c) => c.type === 'code' && c.content.trim())
    for (const cell of codeCells) {
      await runCell(cell.id)
    }
  }, [cells, runCell])

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        onSave?.()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onSave])

  // ---- Drag and drop ----
  const handleDragStart = useCallback((e: React.DragEvent, cellId: string) => {
    e.dataTransfer.setData('rmd-cell-id', cellId)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault()
      const draggedId = e.dataTransfer.getData('rmd-cell-id')
      if (!draggedId || draggedId === targetId) return

      setCells((prev) => {
        const fromIdx = prev.findIndex((c) => c.id === draggedId)
        const toIdx = prev.findIndex((c) => c.id === targetId)
        if (fromIdx < 0 || toIdx < 0) return prev
        const updated = [...prev]
        const [moved] = updated.splice(fromIdx, 1)
        updated.splice(toIdx, 0, moved)
        syncToFile(updated)
        return updated
      })
    },
    [syncToFile],
  )

  // ---- Markdown preview toggle ----
  const togglePreview = useCallback((cellId: string) => {
    setPreviewCells((prev) => {
      const next = new Set(prev)
      if (next.has(cellId)) next.delete(cellId)
      else next.add(cellId)
      return next
    })
  }, [])

  // ---- Computed ----
  const codeCellCount = useMemo(
    () => cells.filter((c) => c.type === 'code').length,
    [cells],
  )

  const editorOptions = useMemo(() => getMiniEditorOptions(readOnly, fontSize), [readOnly, fontSize])

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5 bg-muted/30">
        <Badge variant="outline" className="text-[10px] font-normal">
          {t('files.notebook_label')}
        </Badge>
        <span className="text-[10px] text-muted-foreground">
          {codeCellCount} chunk{codeCellCount !== 1 ? 's' : ''}
        </span>
        <div className="flex-1" />
        {!readOnly && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs gap-1"
              onClick={runAll}
            >
              <PlayCircle size={12} />
              {t('files.notebook_run_all')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-6 text-xs gap-1">
                  <Plus size={12} />
                  {t('files.notebook_add_cell')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => addCell(cells[cells.length - 1]?.id ?? null, 'markdown')}>
                  <FileText size={14} />
                  Markdown
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => addCell(cells[cells.length - 1]?.id ?? null, 'code', 'r')}>
                  <Code size={14} />
                  R
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => addCell(cells[cells.length - 1]?.id ?? null, 'code', 'python')}>
                  <Code size={14} />
                  Python
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => addCell(cells[cells.length - 1]?.id ?? null, 'code', 'sql')}>
                  <Code size={14} />
                  SQL
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {/* Cells */}
      <ScrollArea className="flex-1">
        <div className="max-w-4xl mx-auto py-3 px-3 space-y-2">
          {cells.map((cell, idx) => (
            <RmdCellBlock
              key={cell.id}
              cell={cell}
              index={idx}
              totalCells={cells.length}
              state={cellStates.get(cell.id)}
              isActive={activeCell === cell.id}
              isPreview={previewCells.has(cell.id)}
              readOnly={readOnly}
              theme={resolvedTheme}
              editorOptions={editorOptions}
              onFocus={() => setActiveCell(cell.id)}
              onContentChange={(v) => updateCellContent(cell.id, v)}
              onRun={() => runCell(cell.id)}
              onRemove={() => removeCell(cell.id)}
              onMoveUp={() => moveCell(cell.id, 'up')}
              onMoveDown={() => moveCell(cell.id, 'down')}
              onTogglePreview={() => togglePreview(cell.id)}
              onDragStart={(e) => handleDragStart(e, cell.id)}
              onDrop={(e) => handleDrop(e, cell.id)}
              onAddAfter={(type, lang) => addCell(cell.id, type, lang)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cell block
// ---------------------------------------------------------------------------

interface RmdCellBlockProps {
  cell: RmdCell
  index: number
  totalCells: number
  state?: CellState
  isActive: boolean
  isPreview: boolean
  readOnly: boolean
  theme: string
  editorOptions: Monaco.editor.IStandaloneEditorConstructionOptions
  onFocus: () => void
  onContentChange: (value: string) => void
  onRun: () => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onTogglePreview: () => void
  onDragStart: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onAddAfter: (type: RmdCell['type'], language?: string) => void
}

function RmdCellBlock({
  cell,
  index,
  totalCells,
  state,
  isActive,
  isPreview,
  readOnly,
  theme,
  editorOptions,
  onFocus,
  onContentChange,
  onRun,
  onRemove,
  onMoveUp,
  onMoveDown,
  onTogglePreview,
  onDragStart,
  onDrop,
  onAddAfter,
}: RmdCellBlockProps) {
  const { t } = useTranslation()
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Auto-resize Monaco editor to fit content
  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor

    const updateHeight = () => {
      const contentHeight = editor.getContentHeight()
      const el = editor.getDomNode()?.parentElement
      if (el) {
        el.style.height = `${Math.max(contentHeight, 36)}px`
      }
      editor.layout()
    }

    editor.onDidContentSizeChange(updateHeight)
    updateHeight()

    // Cmd+Enter = run cell, Cmd+Shift+Enter = (could be run all)
    if (!readOnly && cell.type === 'code') {
      editor.addCommand(
        // eslint-disable-next-line no-bitwise
        (window.navigator.platform.includes('Mac') ? 2048 : 2048) | 3, // Cmd/Ctrl + Enter
        () => onRun(),
      )
    }
  }

  // Determine Monaco language
  const monacoLang = cell.type === 'yaml'
    ? 'yaml'
    : cell.type === 'markdown'
      ? 'markdown'
      : LANG_MONACO_MAP[cell.language ?? ''] ?? 'plaintext'

  // Status indicator
  const statusIcon = state?.status === 'running'
    ? <Loader2 size={12} className="animate-spin text-blue-500" />
    : state?.status === 'success'
      ? <Check size={12} className="text-green-500" />
      : state?.status === 'error'
        ? <XCircle size={12} className="text-red-500" />
        : null

  const borderColor = isActive
    ? 'border-primary/40'
    : cell.type === 'code'
      ? 'border-border'
      : 'border-transparent'

  return (
    <div
      ref={containerRef}
      className={`group rounded border transition-colors ${borderColor}`}
      onClick={onFocus}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
      onDrop={onDrop}
    >
      {/* Cell header */}
      <div className="flex items-center gap-1 px-2 py-0.5 text-[10px] opacity-60 group-hover:opacity-100 transition-opacity">
        {/* Drag handle */}
        {!readOnly && (
          <div
            draggable
            onDragStart={onDragStart}
            className="cursor-grab active:cursor-grabbing"
          >
            <GripVertical size={12} className="text-muted-foreground/50" />
          </div>
        )}

        {/* Cell type badge */}
        {cell.type === 'yaml' && (
          <Badge variant="outline" className="text-[9px] h-4 px-1">
            <Settings2 size={10} className="mr-0.5" /> YAML
          </Badge>
        )}
        {cell.type === 'markdown' && (
          <Badge variant="outline" className="text-[9px] h-4 px-1">
            <FileText size={10} className="mr-0.5" /> Markdown
          </Badge>
        )}
        {cell.type === 'code' && cell.language && (
          <Badge
            variant="outline"
            className={`text-[9px] h-4 px-1 ${LANG_COLORS[cell.language] ?? ''}`}
          >
            <Code size={10} className="mr-0.5" />
            {cell.language.toUpperCase()}
          </Badge>
        )}
        {cell.chunkLabel && (
          <span className="text-muted-foreground/70 font-mono">{cell.chunkLabel}</span>
        )}

        {statusIcon}

        <div className="flex-1" />

        {/* Actions (visible on hover) */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {cell.type === 'code' && !readOnly && (
            <button
              onClick={(e) => { e.stopPropagation(); onRun() }}
              className="p-0.5 rounded hover:bg-accent"
              title={t('files.notebook_run_cell')}
            >
              <Play size={11} />
            </button>
          )}
          {cell.type === 'markdown' && (
            <button
              onClick={(e) => { e.stopPropagation(); onTogglePreview() }}
              className="p-0.5 rounded hover:bg-accent"
              title={isPreview ? t('files.notebook_edit') : t('files.notebook_preview')}
            >
              {isPreview ? <Pencil size={11} /> : <Eye size={11} />}
            </button>
          )}
          {!readOnly && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onMoveUp() }}
                disabled={index === 0}
                className="p-0.5 rounded hover:bg-accent disabled:opacity-30"
              >
                <ChevronUp size={11} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onMoveDown() }}
                disabled={index === totalCells - 1}
                className="p-0.5 rounded hover:bg-accent disabled:opacity-30"
              >
                <ChevronDown size={11} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onRemove() }}
                className="p-0.5 rounded hover:bg-accent text-destructive/70"
              >
                <Trash2 size={11} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Cell body */}
      {cell.type === 'markdown' && isPreview ? (
        // Rendered markdown preview
        <div
          className="px-3 py-2 prose prose-sm dark:prose-invert max-w-none min-h-[2rem] cursor-pointer [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          onDoubleClick={onTogglePreview}
        >
          {cell.content.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {cell.content}
            </ReactMarkdown>
          ) : (
            <p className="text-muted-foreground/50 italic">Empty markdown cell</p>
          )}
        </div>
      ) : (
        // Monaco editor
        <div className={cell.type === 'code' ? 'bg-muted/20' : ''}>
          <Editor
            value={cell.content}
            language={monacoLang}
            theme={theme}
            options={editorOptions}
            onChange={(v) => onContentChange(v ?? '')}
            onMount={handleEditorMount}
            loading={
              <pre className="text-xs font-mono p-2 whitespace-pre-wrap min-h-[36px]">
                {cell.content}
              </pre>
            }
          />
        </div>
      )}

      {/* Cell output */}
      {state?.output && <CellOutput output={state.output} />}

      {/* Add cell button (between cells, visible on hover) */}
      {!readOnly && (
        <div className="relative h-0 overflow-visible">
          <div className="absolute left-1/2 -translate-x-1/2 -bottom-3 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted border text-[9px] text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                  <Plus size={10} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                <DropdownMenuItem onClick={() => onAddAfter('markdown')}>
                  <FileText size={14} /> Markdown
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAddAfter('code', 'r')}>
                  <Code size={14} /> R
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAddAfter('code', 'python')}>
                  <Code size={14} /> Python
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAddAfter('code', 'sql')}>
                  <Code size={14} /> SQL
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}
    </div>
  )
}
