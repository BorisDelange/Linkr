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
  useImperativeHandle,
  forwardRef,
} from 'react'
import { useTranslation } from 'react-i18next'
import Editor, { type OnMount, type BeforeMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Play,
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
  ChevronsUpDown,
} from 'lucide-react'
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
import { linkrDark, linkrLight } from '@/components/editor/monaco-themes'
import { useShortcutStore } from '@/stores/shortcut-store'
import type { KeyCombo } from '@/types/shortcuts'
import type { RuntimeOutput } from '@/lib/runtimes/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CellStatus = 'idle' | 'running' | 'success' | 'error'

export interface CellState {
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
    scrollbar: { vertical: 'hidden', horizontal: 'auto', alwaysConsumeMouseWheel: false },
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
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface RmdNotebookProps {
  content: string
  onChange?: (newContent: string) => void
  readOnly?: boolean
  onSave?: () => void
  /** Called with rendered HTML so the parent can display it (e.g. in an output tab) */
  onRenderOutput?: (html: string, title: string) => void
  activeConnectionId?: string | null
  /** Override cell parser (default: parseRmdFile). Used by ipynb wrapper. */
  parseFn?: (content: string) => RmdCell[]
  /** Override cell serializer (default: serializeRmdFile). Used by ipynb wrapper. */
  serializeFn?: (cells: RmdCell[]) => string
}

/** Imperative handle exposed to the parent for toolbar actions */
export interface RmdNotebookHandle {
  runCell: () => void
  runAll: () => void
  runAbove: () => void
  renderPreview: () => void
  renderHtml: () => void
  renderPdf: () => void
  addCell: (type: 'markdown' | 'code' | 'yaml', language?: string) => void
  hasYamlCell: boolean
  isRendering: boolean
  /** Access internal cells and their execution states (used by IpynbNotebook for download). */
  getCells: () => RmdCell[]
  getCellStates: () => Map<string, CellState>
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const RmdNotebook = forwardRef<RmdNotebookHandle, RmdNotebookProps>(function RmdNotebook({
  content,
  onChange,
  readOnly = false,
  onSave,
  onRenderOutput,
  activeConnectionId,
  parseFn = parseRmdFile,
  serializeFn = serializeRmdFile,
}, ref) {
  const { t } = useTranslation()
  const darkMode = useAppStore((s) => s.darkMode)
  const editorTheme = useAppStore((s) => s.editorSettings.theme)
  const resolvedTheme = editorTheme === 'auto'
    ? darkMode ? 'linkr-dark' : 'linkr-light'
    : editorTheme
  const fontSize = useAppStore((s) => s.editorSettings.fontSize)

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    monaco.editor.defineTheme('linkr-dark', linkrDark)
    monaco.editor.defineTheme('linkr-light', linkrLight)
  }, [])

  // ---- State ----
  const [cells, setCells] = useState<RmdCell[]>(() => parseFn(content))
  const cellsRef = useRef(cells)
  cellsRef.current = cells
  const [cellStates, setCellStates] = useState<Map<string, CellState>>(new Map())
  const [previewCells, setPreviewCells] = useState<Set<string>>(new Set())
  const [activeCell, setActiveCell] = useState<string | null>(null)

  // Map of cell id → Monaco editor instance, so advanceCell can focus the next editor
  const editorMapRef = useRef<Map<string, Monaco.editor.IStandaloneCodeEditor>>(new Map())

  // Stable render order — cells are rendered in this order (DOM insertion order).
  // CSS `order` is used to display them in the logical order (`cells`).
  // This prevents React from moving DOM nodes when cells are reordered,
  // which would destroy Monaco editor instances ("InstantiationService disposed").
  const [renderOrder, setRenderOrder] = useState<string[]>(() =>
    parseFn(content).map((c) => c.id),
  )

  // Drag-and-drop state
  const [draggedCellId, setDraggedCellId] = useState<string | null>(null)
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null)

  // Track internal edits to avoid re-parsing when onChange is called
  const internalEdit = useRef(false)

  // Re-parse when content changes externally
  useEffect(() => {
    if (internalEdit.current) {
      internalEdit.current = false
      return
    }
    const parsed = parseFn(content)
    setCells(parsed)
    setRenderOrder(parsed.map((c) => c.id))
  }, [content, parseFn])

  // ---- Serialization ----
  const syncTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const syncToFile = useCallback(
    (updatedCells: RmdCell[]) => {
      if (!onChange) return
      if (syncTimeout.current) clearTimeout(syncTimeout.current)
      syncTimeout.current = setTimeout(() => {
        internalEdit.current = true
        onChange(serializeFn(updatedCells))
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
      // YAML front-matter: only one allowed, always at position 0
      if (type === 'yaml') {
        setCells((prev) => {
          if (prev.some((c) => c.type === 'yaml')) return prev
          const newCell: RmdCell = {
            id: `rmd-new-${Date.now()}`,
            type: 'yaml',
            content: "title: 'Untitled'\noutput: html_document\n",
            dirty: true,
          }
          const updated = [newCell, ...prev]
          syncToFile(updated)
          setRenderOrder((ro) => [...ro, newCell.id])
          setActiveCell(newCell.id)
          return updated
        })
        return
      }

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
      // Append to render order (new cells go at DOM end, CSS order positions them)
      setRenderOrder((prev) => [...prev, newCell.id])
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
      setRenderOrder((prev) => prev.filter((id) => id !== cellId))
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

  // ---- Drag-and-drop handlers ----
  // Reorders `cells` (logical order) WITHOUT touching `renderOrder` (DOM order).
  // This way React never moves DOM nodes → Monaco stays alive.
  const handleDragStart = useCallback((cellId: string) => {
    setDraggedCellId(cellId)
  }, [])

  const handleDragEnd = useCallback(() => {
    if (draggedCellId && dropTargetIdx != null) {
      setCells((prev) => {
        const fromIdx = prev.findIndex((c) => c.id === draggedCellId)
        if (fromIdx < 0) return prev
        const updated = [...prev]
        const [moved] = updated.splice(fromIdx, 1)
        // Adjust target: if dragging forward, removing the item shifts indices
        const toIdx = dropTargetIdx > fromIdx ? dropTargetIdx - 1 : dropTargetIdx
        updated.splice(toIdx, 0, moved)
        syncToFile(updated)
        return updated
      })
    }
    setDraggedCellId(null)
    setDropTargetIdx(null)
  }, [draggedCellId, dropTargetIdx, syncToFile])

  const handleDragCancel = useCallback(() => {
    setDraggedCellId(null)
    setDropTargetIdx(null)
  }, [])

  // ---- Execution ----
  const runCell = useCallback(
    async (cellId: string) => {
      // Use cellsRef to always read the latest cells array, avoiding stale closures
      // when runCell is called from Monaco addCommand callbacks.
      const cell = cellsRef.current.find((c) => c.id === cellId)
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
    [activeConnectionId, t],
  )

  const runAll = useCallback(async () => {
    const codeCells = cells.filter((c) => c.type === 'code' && c.content.trim())
    for (const cell of codeCells) {
      await runCell(cell.id)
    }
  }, [cells, runCell])

  const runAbove = useCallback(async () => {
    if (!activeCell) return
    const idx = cells.findIndex((c) => c.id === activeCell)
    if (idx < 0) return
    const above = cells.slice(0, idx).filter((c) => c.type === 'code' && c.content.trim())
    for (const cell of above) {
      await runCell(cell.id)
    }
  }, [cells, activeCell, runCell])

  /** Advance activeCell to the next cell (any type) and focus its editor */
  const advanceCell = useCallback(() => {
    if (!activeCell) return
    const currentCells = cellsRef.current
    const idx = currentCells.findIndex((c) => c.id === activeCell)
    if (idx >= 0 && idx + 1 < currentCells.length) {
      const nextId = currentCells[idx + 1].id
      setActiveCell(nextId)
      // Focus the next cell's Monaco editor so the keyboard shortcut fires there
      requestAnimationFrame(() => {
        editorMapRef.current.get(nextId)?.focus()
      })
    }
  }, [activeCell])

  // ---- Render ----
  const [isRendering, setIsRendering] = useState(false)

  /** Build a self-contained HTML document from the current notebook state */
  const buildHtml = useCallback(async (): Promise<{ html: string; title: string }> => {
    // Run all chunks first
    const codeCells = cells.filter((c) => c.type === 'code' && c.content.trim())
    for (const cell of codeCells) {
      await runCell(cell.id)
    }
    // Small delay for state propagation
    await new Promise((r) => setTimeout(r, 150))

    const states = cellStates

    // Extract YAML title
    const yamlCell = cells.find((c) => c.type === 'yaml')
    const titleMatch = yamlCell?.content.match(/title:\s*["']?(.+?)["']?\s*$/m)
    const title = titleMatch?.[1] ?? 'Notebook'

    // Build body HTML
    const bodyParts: string[] = []
    for (const cell of cells) {
      if (cell.type === 'yaml') continue

      if (cell.type === 'markdown') {
        bodyParts.push(`<div class="md-cell">${escapeHtml(cell.content)}</div>`)
        continue
      }

      if (cell.type === 'code') {
        bodyParts.push(
          `<pre class="code-cell"><code class="language-${cell.language ?? ''}">${escapeHtml(cell.content)}</code></pre>`
        )

        const st = states.get(cell.id)
        if (st?.output) {
          const out = st.output
          if (out.stdout) {
            bodyParts.push(`<pre class="output stdout">${escapeHtml(out.stdout)}</pre>`)
          }
          if (out.stderr) {
            bodyParts.push(`<pre class="output stderr">${escapeHtml(out.stderr)}</pre>`)
          }
          for (const fig of out.figures) {
            if (fig.type === 'svg') {
              bodyParts.push(`<div class="figure">${fig.data}</div>`)
            } else {
              bodyParts.push(`<div class="figure"><img src="${fig.data}" alt="${escapeHtml(fig.label)}" /></div>`)
            }
          }
          if (out.table) {
            const { headers, rows } = out.table
            let tableHtml = '<table class="output-table"><thead><tr>'
            for (const h of headers) tableHtml += `<th>${escapeHtml(h)}</th>`
            tableHtml += '</tr></thead><tbody>'
            for (const row of rows.slice(0, 100)) {
              tableHtml += '<tr>'
              for (const val of row) tableHtml += `<td>${escapeHtml(val)}</td>`
              tableHtml += '</tr>'
            }
            tableHtml += '</tbody></table>'
            bodyParts.push(tableHtml)
          }
          if (out.html) {
            bodyParts.push(`<div class="html-output">${out.html}</div>`)
          }
        }
      }
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1a1a1a; background: #fff; }
  .md-cell { margin: 1rem 0; }
  .code-cell { background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 4px; padding: 0.75rem 1rem; overflow-x: auto; font-size: 13px; }
  .output { margin: 0.25rem 0 1rem; padding: 0.5rem 1rem; border-radius: 4px; font-size: 12px; white-space: pre-wrap; }
  .stdout { background: #f8f8f8; color: #555; }
  .stderr { background: #fff5f5; color: #c00; }
  .figure { text-align: center; margin: 1rem 0; }
  .figure img, .figure svg { max-width: 100%; }
  .output-table { border-collapse: collapse; width: 100%; font-size: 12px; margin: 0.5rem 0 1rem; }
  .output-table th, .output-table td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; }
  .output-table th { background: #f5f5f5; font-weight: 600; }
  .output-table tr:nth-child(even) { background: #fafafa; }
  .html-output { margin: 0.5rem 0; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
  p { margin: 0.5em 0; }
  code { font-family: 'SF Mono', Monaco, Consolas, monospace; }
  @media (prefers-color-scheme: dark) {
    body { color: #e0e0e0; background: #1a1a1a; }
    .code-cell { background: #2a2a2a; border-color: #3a3a3a; color: #d4d4d4; }
    .stdout { background: #222; color: #aaa; }
    .stderr { background: #2a1515; color: #f88; }
    .output-table th, .output-table td { border-color: #3a3a3a; }
    .output-table th { background: #2a2a2a; }
    .output-table tr:nth-child(even) { background: #222; }
    a { color: #6ab0f3; }
  }
  @media print { .code-cell { break-inside: avoid; } .figure { break-inside: avoid; } .output-table { break-inside: avoid; font-size: 10px; } }
</style>
</head>
<body>
${bodyParts.join('\n')}
<script>
  document.querySelectorAll('.md-cell').forEach(el => {
    el.innerHTML = marked.parse(el.textContent || '');
  });
<\/script>
</body>
</html>`

    return { html, title }
  }, [cells, cellStates, runCell])

  /** Download as HTML file */
  const handleRenderPreview = useCallback(async () => {
    setIsRendering(true)
    try {
      const { html, title } = await buildHtml()
      if (onRenderOutput) {
        onRenderOutput(html, title)
      } else {
        // Fallback: open in new tab
        const w = window.open('', '_blank')
        if (w) { w.document.write(html); w.document.close() }
      }
    } finally {
      setIsRendering(false)
    }
  }, [buildHtml, onRenderOutput])

  const handleRenderHtml = useCallback(async () => {
    setIsRendering(true)
    try {
      const { html, title } = await buildHtml()
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title.replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'notebook'}.html`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setIsRendering(false)
    }
  }, [buildHtml])

  /** Open rendered HTML in new tab with print dialog for PDF export */
  const handleRenderPdf = useCallback(async () => {
    setIsRendering(true)
    try {
      const { html } = await buildHtml()
      const printWindow = window.open('', '_blank')
      if (!printWindow) return
      printWindow.document.write(html)
      printWindow.document.close()
      // Wait for marked.js to load and render markdown, then trigger print
      printWindow.addEventListener('load', () => {
        setTimeout(() => printWindow.print(), 300)
      })
    } finally {
      setIsRendering(false)
    }
  }, [buildHtml])

  // Keyboard shortcut → preview in output tab
  const handleRender = handleRenderPreview

  // ---- Markdown preview toggle ----
  const togglePreview = useCallback((cellId: string) => {
    setPreviewCells((prev) => {
      const next = new Set(prev)
      if (next.has(cellId)) next.delete(cellId)
      else next.add(cellId)
      return next
    })
  }, [])

  // ---- Keyboard shortcuts ----
  const getBinding = useShortcutStore((s) => s.getBinding)

  useEffect(() => {
    const matchCombo = (e: KeyboardEvent, combo: KeyCombo) => {
      if (!combo.key) return false // unbound
      const ctrlOrMeta = e.metaKey || e.ctrlKey
      return (
        ctrlOrMeta === combo.ctrlOrMeta &&
        e.shiftKey === combo.shift &&
        e.altKey === combo.alt &&
        e.key.toLowerCase() === combo.key.toLowerCase()
      )
    }

    const handler = (e: KeyboardEvent) => {
      // Save file — Cmd+S
      if (matchCombo(e, getBinding('save_file'))) {
        e.preventDefault()
        onSave?.()
        return
      }
      if (readOnly) return

      // If a Monaco editor has focus, skip notebook shortcuts here — Monaco's
      // addCommand already handles them per-cell.  This avoids double-firing.
      const target = e.target as HTMLElement | null
      const inMonaco = target?.closest('.monaco-editor') != null

      const activeCellObj = activeCell ? cells.find((c) => c.id === activeCell) : null

      // When Monaco has focus, its addCommand handles run/advance per-cell.
      // Only use the window handler as fallback (e.g. focus on cell header).
      if (inMonaco) return

      // Run cell and advance — Cmd+Shift+Enter (rmd_run_chunk) or Cmd+Enter (run_selection_or_line)
      if (
        matchCombo(e, getBinding('rmd_run_chunk')) ||
        matchCombo(e, getBinding('run_selection_or_line'))
      ) {
        e.preventDefault()
        if (activeCell) {
          if (activeCellObj?.type === 'code') runCell(activeCell)
          else if (activeCellObj?.type === 'markdown') togglePreview(activeCell)
          // yaml: nothing to run, just advance
          advanceCell()
        }
        return
      }
      // Run cell (stay — no advance)
      if (matchCombo(e, getBinding('rmd_run_chunk_stay'))) {
        e.preventDefault()
        if (activeCell) {
          if (activeCellObj?.type === 'markdown') togglePreview(activeCell)
          else runCell(activeCell)
        }
        return
      }
      // Run cell and insert below
      if (matchCombo(e, getBinding('rmd_run_chunk_insert'))) {
        e.preventDefault()
        if (activeCell) {
          if (activeCellObj?.type === 'code') runCell(activeCell)
          addCell(activeCell, 'code', activeCellObj?.language ?? 'r')
        }
        return
      }

      // Run all
      if (matchCombo(e, getBinding('rmd_run_all'))) {
        e.preventDefault()
        runAll()
        return
      }
      // Run above
      if (matchCombo(e, getBinding('rmd_run_above'))) {
        e.preventDefault()
        runAbove()
        return
      }
      // Insert chunk (generic)
      if (matchCombo(e, getBinding('rmd_insert_chunk'))) {
        e.preventDefault()
        addCell(activeCell, 'code', 'r')
        return
      }
      // Insert cell above
      if (matchCombo(e, getBinding('rmd_insert_chunk_above'))) {
        e.preventDefault()
        // Insert before active cell: find the cell before it
        const idx = activeCell ? cells.findIndex((c) => c.id === activeCell) : -1
        const beforeId = idx > 0 ? cells[idx - 1].id : null
        addCell(beforeId, 'code', 'r')
        return
      }
      // Insert cell below
      if (matchCombo(e, getBinding('rmd_insert_chunk_below'))) {
        e.preventDefault()
        addCell(activeCell, 'code', 'r')
        return
      }
      // Delete cell
      if (matchCombo(e, getBinding('rmd_delete_chunk'))) {
        e.preventDefault()
        if (activeCell) removeCell(activeCell)
        return
      }
      // Render
      if (matchCombo(e, getBinding('rmd_render'))) {
        e.preventDefault()
        handleRender()
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onSave, handleRender, readOnly, activeCell, cells, runCell, runAll, runAbove, addCell, removeCell, togglePreview, advanceCell, getBinding])

  const editorOptions = useMemo(() => getMiniEditorOptions(readOnly, fontSize), [readOnly, fontSize])

  // ---- Imperative handle for parent toolbar ----
  const hasYamlCell = cells.some((c) => c.type === 'yaml')

  useImperativeHandle(ref, () => ({
    runCell: () => { if (activeCell) runCell(activeCell) },
    runAll,
    runAbove,
    renderPreview: handleRenderPreview,
    renderHtml: handleRenderHtml,
    renderPdf: handleRenderPdf,
    addCell: (type: 'markdown' | 'code' | 'yaml', language?: string) => {
      addCell(activeCell ?? cells[cells.length - 1]?.id ?? null, type, language)
    },
    hasYamlCell,
    isRendering,
    getCells: () => cells,
    getCellStates: () => cellStates,
  }), [activeCell, runCell, runAll, runAbove, handleRenderPreview, handleRenderHtml, handleRenderPdf, addCell, cells, hasYamlCell, isRendering, cellStates])

  return (
    <div className="flex h-full flex-col">
      {/* Cells — rendered in stable DOM order, visually ordered via CSS `order` */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="max-w-4xl mx-auto py-3 px-3 flex flex-col gap-2">
          {renderOrder.map((cellId) => {
            const logicalIdx = cells.findIndex((c) => c.id === cellId)
            const cell = cells[logicalIdx]
            if (!cell) return null
            return (
              <RmdCellBlock
                key={cell.id}
                cell={cell}
                index={logicalIdx}
                totalCells={cells.length}
                state={cellStates.get(cell.id)}
                isActive={activeCell === cell.id}
                isPreview={previewCells.has(cell.id)}
                readOnly={readOnly}
                theme={resolvedTheme}
                editorOptions={editorOptions}
                beforeMount={handleBeforeMount}
                cssOrder={logicalIdx * 2 + 1}
                isDragging={draggedCellId === cell.id}
                isDragActive={draggedCellId != null}
                dropTargetIdx={dropTargetIdx}
                onFocus={() => setActiveCell(cell.id)}
                onContentChange={(v) => updateCellContent(cell.id, v)}
                onRun={() => runCell(cell.id)}
                onAdvance={advanceCell}
                onRemove={() => removeCell(cell.id)}
                onMoveUp={() => moveCell(cell.id, 'up')}
                onMoveDown={() => moveCell(cell.id, 'down')}
                onTogglePreview={() => togglePreview(cell.id)}
                onAddAfter={(type, lang) => addCell(cell.id, type, lang)}
                hasYamlCell={hasYamlCell}
                onEditorMount={(editor) => editorMapRef.current.set(cell.id, editor)}
                onDragStart={() => handleDragStart(cell.id)}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
                onDropTargetChange={setDropTargetIdx}
              />
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
})

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
  beforeMount: BeforeMount
  cssOrder: number
  isDragging: boolean
  isDragActive: boolean
  dropTargetIdx: number | null
  onFocus: () => void
  onContentChange: (value: string) => void
  onRun: () => void
  onAdvance: () => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onTogglePreview: () => void
  onAddAfter: (type: RmdCell['type'], language?: string) => void
  hasYamlCell: boolean
  onEditorMount: (editor: Monaco.editor.IStandaloneCodeEditor) => void
  onDragStart: () => void
  onDragEnd: () => void
  onDragCancel: () => void
  onDropTargetChange: (idx: number | null) => void
}

const RMD_COLLAPSE_LINE_THRESHOLD = 30
const RMD_COLLAPSED_HEIGHT = 30 * 18 + 8

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
  beforeMount,
  cssOrder,
  isDragging,
  isDragActive,
  dropTargetIdx,
  onFocus,
  onContentChange,
  onRun,
  onAdvance,
  onRemove,
  onMoveUp,
  onMoveDown,
  onTogglePreview,
  onAddAfter,
  hasYamlCell,
  onEditorMount,
  onDragStart,
  onDragEnd,
  onDragCancel,
  onDropTargetChange,
}: RmdCellBlockProps) {
  const { t } = useTranslation()
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Use refs so Monaco keybindings always call the latest version
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun
  const onAdvanceRef = useRef(onAdvance)
  onAdvanceRef.current = onAdvance
  const onTogglePreviewRef = useRef(onTogglePreview)
  onTogglePreviewRef.current = onTogglePreview
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus

  const lineCount = cell.content.split('\n').length
  const isLong = lineCount > RMD_COLLAPSE_LINE_THRESHOLD
  const [collapsed, setCollapsed] = useState(false)
  const [editorHeight, setEditorHeight] = useState(Math.max(lineCount * 18 + 8, 36))

  // Auto-resize Monaco editor to fit content
  const handleEditorMount: OnMount = (editor, _monaco) => {
    editorRef.current = editor
    onEditorMount(editor)

    const updateHeight = () => {
      const h = Math.max(editor.getContentHeight(), 36)
      setEditorHeight(h)
      const el = editor.getDomNode()?.parentElement
      if (el) {
        el.style.height = `${h}px`
      }
      editor.layout()
    }

    editor.onDidContentSizeChange(updateHeight)
    updateHeight()

    // Sync activeCell when this Monaco editor receives focus
    editor.onDidFocusEditorWidget(() => onFocusRef.current())

    // Intercept notebook shortcuts directly on the editor DOM rather than
    // using editor.addCommand, which registers in a global keybinding service
    // shared across all Monaco instances — only the last editor's callback wins.
    // A per-editor DOM keydown listener ensures each cell runs its own code.
    if (!readOnly) {
      const editorDom = editor.getDomNode()
      if (editorDom) {
        editorDom.addEventListener('keydown', (e: KeyboardEvent) => {
          const matchCombo = (ev: KeyboardEvent, combo: KeyCombo) => {
            if (!combo.key) return false
            const ctrlOrMeta = ev.metaKey || ev.ctrlKey
            return (
              ctrlOrMeta === combo.ctrlOrMeta &&
              ev.shiftKey === combo.shift &&
              ev.altKey === combo.alt &&
              ev.key.toLowerCase() === combo.key.toLowerCase()
            )
          }

          const gb = useShortcutStore.getState().getBinding

          // Run cell and advance
          if (matchCombo(e, gb('rmd_run_chunk')) || matchCombo(e, gb('run_selection_or_line'))) {
            e.preventDefault()
            e.stopPropagation()
            if (cell.type === 'code') onRunRef.current()
            else if (cell.type === 'markdown') onTogglePreviewRef.current()
            // yaml: nothing to run, just advance
            onAdvanceRef.current()
            return
          }

          // Run cell stay (no advance)
          if (matchCombo(e, gb('rmd_run_chunk_stay'))) {
            e.preventDefault()
            e.stopPropagation()
            if (cell.type === 'code') onRunRef.current()
            else if (cell.type === 'markdown') onTogglePreviewRef.current()
            return
          }
        })
      }
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

  const borderColor = isDragging
    ? 'border-primary/60 opacity-50'
    : isActive
      ? 'border-primary/40'
      : cell.type === 'code'
        ? 'border-border'
        : 'border-transparent'

  // ---- Drag handle ----
  const handleDragStartNative = useCallback((e: React.DragEvent) => {
    // Custom ghost image: small pill so Monaco content isn't captured
    const ghost = document.createElement('div')
    ghost.textContent = cell.type === 'code'
      ? `${(cell.language ?? '').toUpperCase()} chunk`
      : cell.type === 'markdown' ? 'Markdown' : 'YAML'
    ghost.style.cssText =
      'position:fixed;top:-999px;left:-999px;padding:4px 12px;border-radius:8px;font-size:11px;' +
      'background:#3b82f6;color:#fff;white-space:nowrap;font-family:system-ui;pointer-events:none;'
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 0, 0)
    requestAnimationFrame(() => document.body.removeChild(ghost))
    e.dataTransfer.effectAllowed = 'move'
    onDragStart()
  }, [cell.type, cell.language, onDragStart])

  // Drop zone highlight: shown before this cell (logical index)
  const isDropBefore = isDragActive && dropTargetIdx === index && !isDragging

  return (
    <>
      {/* Drop zone BEFORE this cell */}
      {isDragActive && !isDragging && (
        <div
          style={{ order: cssOrder - 1 }}
          className={`transition-all duration-150 rounded ${isDropBefore ? 'h-8 bg-primary/10 border-2 border-dashed border-primary/40' : 'h-4'}`}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDropTargetChange(index) }}
          onDrop={(e) => { e.preventDefault(); onDragEnd() }}
        />
      )}

      <div
        ref={containerRef}
        style={{ order: cssOrder }}
        className={`group rounded border transition-colors ${borderColor}`}
        onClick={onFocus}
        onDragOver={(e) => e.preventDefault()}
      >
        {/* Cell header */}
        <div className="flex items-center gap-1 px-2 py-0.5 text-[10px] opacity-60 group-hover:opacity-100 transition-opacity">
          {/* Drag handle + move buttons */}
          {!readOnly && (
            <div className="flex items-center gap-0">
              <div
                draggable
                onDragStart={handleDragStartNative}
                onDragEnd={() => { onDragCancel() }}
                className="p-0 rounded hover:bg-accent cursor-grab active:cursor-grabbing"
                title="Drag to reorder"
              >
                <GripVertical size={12} className="text-muted-foreground/50" />
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onMoveUp() }}
                disabled={index === 0}
                className="p-0 rounded hover:bg-accent disabled:opacity-20"
                title="Move up"
              >
                <ChevronUp size={12} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onMoveDown() }}
                disabled={index === totalCells - 1}
                className="p-0 rounded hover:bg-accent disabled:opacity-20"
                title="Move down"
              >
                <ChevronDown size={12} />
              </button>
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
              <button
                onClick={(e) => { e.stopPropagation(); onRemove() }}
                className="p-0.5 rounded hover:bg-accent text-destructive/70"
              >
                <Trash2 size={11} />
              </button>
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
            <div
              className="overflow-hidden transition-[height] duration-200"
              style={{ height: collapsed ? RMD_COLLAPSED_HEIGHT : editorHeight }}
            >
              <Editor
                value={cell.content}
                language={monacoLang}
                theme={theme}
                options={editorOptions}
                beforeMount={beforeMount}
                onChange={(v) => onContentChange(v ?? '')}
                onMount={handleEditorMount}
                loading={
                  <pre className="text-xs font-mono p-2 whitespace-pre-wrap min-h-[36px]">
                    {cell.content}
                  </pre>
                }
              />
            </div>
            {isLong && (
              <button
                onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c) }}
                className="flex items-center justify-center gap-1 w-full py-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent/30 transition-colors border-t border-dashed"
              >
                <ChevronsUpDown size={10} />
                {collapsed ? `Show all (${lineCount} lines)` : 'Collapse'}
              </button>
            )}
          </div>
        )}

        {/* Cell output */}
        {state?.output && <CellOutput output={state.output} />}

        {/* Add cell button (between cells, visible on hover) */}
        {!readOnly && !isDragActive && (
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
                  {!hasYamlCell && (
                    <DropdownMenuItem onClick={() => onAddAfter('yaml')}>
                      <Settings2 size={14} /> YAML front-matter
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}
      </div>

      {/* Drop zone AFTER last cell */}
      {isDragActive && index === totalCells - 1 && !isDragging && (
        <div
          style={{ order: cssOrder + 1 }}
          className={`transition-all duration-150 rounded ${dropTargetIdx === totalCells ? 'h-8 bg-primary/10 border-2 border-dashed border-primary/40' : 'h-4'}`}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDropTargetChange(totalCells) }}
          onDrop={(e) => { e.preventDefault(); onDragEnd() }}
        />
      )}
    </>
  )
}

