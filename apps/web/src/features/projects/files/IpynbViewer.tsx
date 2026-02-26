/**
 * Read-only Jupyter Notebook (.ipynb) viewer.
 *
 * Features:
 * - Monaco read-only for code cells (syntax highlighted, dark theme support)
 * - MarkdownRenderer for markdown cells (GFM + KaTeX math)
 * - Inline outputs (images, HTML, tables, errors)
 * - Table of contents from markdown headings
 * - Output-only mode (hide code, show only markdown + outputs)
 */

import { useState, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react'
import { Info, List, Eye, EyeOff, ChevronRight, ChevronsUpDown, Copy, Check, Maximize2, ZoomIn, ZoomOut, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'
import {
  parseIpynbFile,
  getNotebookLanguage,
  type IpynbCell,
  type IpynbOutput,
} from '@/lib/ipynb-parser'
import { linkrDark, linkrLight } from '@/components/editor/monaco-themes'
import { sanitizeHtml } from '@/lib/sanitize'

// ---------------------------------------------------------------------------
// Monaco language map
// ---------------------------------------------------------------------------

const LANG_MAP: Record<string, string> = {
  python: 'python',
  python3: 'python',
  r: 'r',
  julia: 'julia',
  javascript: 'javascript',
  typescript: 'typescript',
  sql: 'sql',
  bash: 'shell',
  sh: 'shell',
  scala: 'scala',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  rust: 'rust',
  go: 'go',
}

function toMonacoLang(lang: string): string {
  return LANG_MAP[lang.toLowerCase()] ?? 'plaintext'
}

// ---------------------------------------------------------------------------
// Monaco options for read-only code cells
// ---------------------------------------------------------------------------

const READONLY_EDITOR_OPTIONS = {
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  lineNumbers: 'off' as const,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  folding: false,
  glyphMargin: false,
  lineDecorationsWidth: 0,
  lineNumbersMinChars: 0,
  renderLineHighlight: 'none' as const,
  scrollbar: { vertical: 'hidden' as const, horizontal: 'auto' as const, alwaysConsumeMouseWheel: false },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  padding: { top: 4, bottom: 4 },
  contextmenu: false,
  wordWrap: 'on' as const,
}

// ---------------------------------------------------------------------------
// TOC extraction from markdown headings
// ---------------------------------------------------------------------------

interface TocEntry {
  level: number
  text: string
  cellIndex: number
}

function extractToc(cells: IpynbCell[]): TocEntry[] {
  const entries: TocEntry[] = []
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].cell_type !== 'markdown') continue
    const lines = cells[i].source.split('\n')
    for (const line of lines) {
      const match = line.match(/^(#{1,6})\s+(.+)$/)
      if (match) {
        entries.push({
          level: match[1].length,
          text: match[2].replace(/[*_`~]/g, '').trim(),
          cellIndex: i,
        })
      }
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface IpynbViewerProps {
  content: string
}

export function IpynbViewer({ content }: IpynbViewerProps) {
  const { t } = useTranslation()
  const darkMode = useAppStore((s) => s.darkMode)
  const editorTheme = useAppStore((s) => s.editorSettings.theme)
  const resolvedTheme = editorTheme === 'auto'
    ? darkMode ? 'linkr-dark' : 'linkr-light'
    : editorTheme

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    monaco.editor.defineTheme('linkr-dark', linkrDark)
    monaco.editor.defineTheme('linkr-light', linkrLight)
  }, [])

  const [outputOnly, setOutputOnly] = useState(false)
  const [tocOpen, setTocOpen] = useState(false)
  const cellRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const notebook = useMemo(() => {
    try {
      return parseIpynbFile(content)
    } catch {
      return null
    }
  }, [content])

  const language = useMemo(
    () => (notebook ? getNotebookLanguage(notebook) : 'python'),
    [notebook],
  )

  const toc = useMemo(
    () => (notebook ? extractToc(notebook.cells) : []),
    [notebook],
  )

  const scrollToCell = useCallback((cellIndex: number) => {
    const el = cellRefs.current.get(cellIndex)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const registerCellRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) cellRefs.current.set(index, el)
    else cellRefs.current.delete(index)
  }, [])

  if (!notebook) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Failed to parse notebook
      </div>
    )
  }

  if (notebook.cells.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('files.ipynb_no_cells')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 border-b px-3 py-1.5 bg-muted/30">
        {/* TOC toggle */}
        {toc.length > 0 && (
          <Button
            variant={tocOpen ? 'secondary' : 'ghost'}
            size="sm"
            className="h-6 text-xs gap-1"
            onClick={() => setTocOpen(!tocOpen)}
          >
            <List size={12} />
            TOC
          </Button>
        )}

        <div className="flex-1" />

        {/* Output-only toggle */}
        <Button
          variant={outputOnly ? 'secondary' : 'ghost'}
          size="sm"
          className="h-6 text-xs gap-1"
          onClick={() => setOutputOnly(!outputOnly)}
        >
          {outputOnly ? <Eye size={12} /> : <EyeOff size={12} />}
          {outputOnly ? 'Show code' : 'Hide code'}
        </Button>

        {/* Read-only indicator */}
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
          <Info size={10} />
          Read-only
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* TOC sidebar */}
        {tocOpen && toc.length > 0 && (
          <div className="w-56 shrink-0 border-r overflow-y-auto bg-muted/20">
            <div className="p-2 space-y-0.5">
              {toc.map((entry, i) => (
                <button
                  key={i}
                  onClick={() => scrollToCell(entry.cellIndex)}
                  className="flex items-center gap-1 w-full text-left px-1.5 py-1 text-xs rounded hover:bg-accent/50 transition-colors"
                  style={{ paddingLeft: `${(entry.level - 1) * 12 + 6}px` }}
                >
                  <ChevronRight size={10} className="shrink-0 text-muted-foreground/40" />
                  <span className="truncate">{entry.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Notebook content */}
        <ScrollArea className="flex-1">
          <div className="max-w-4xl mx-auto py-4 px-4 space-y-0">
            {notebook.cells.map((cell, idx) => (
              <div key={idx} ref={(el) => registerCellRef(idx, el)}>
                <IpynbCellRenderer
                  cell={cell}
                  language={language}
                  theme={resolvedTheme}
                  outputOnly={outputOnly}
                  beforeMount={handleBeforeMount}
                />
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collapse threshold: cells above this many lines get a collapse toggle
// ---------------------------------------------------------------------------

const COLLAPSE_LINE_THRESHOLD = 25
const COLLAPSED_HEIGHT = 25 * 18 + 8

// ---------------------------------------------------------------------------
// Cell renderer
// ---------------------------------------------------------------------------

function IpynbCellRenderer({
  cell,
  language,
  theme,
  outputOnly,
  beforeMount,
}: {
  cell: IpynbCell
  language: string
  theme: string
  outputOnly: boolean
  beforeMount: BeforeMount
}) {
  if (cell.cell_type === 'markdown') {
    return (
      <div className="py-2 px-1 prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
          {cell.source}
        </ReactMarkdown>
      </div>
    )
  }

  if (cell.cell_type === 'raw') {
    if (outputOnly) return null
    return (
      <pre className="py-2 px-3 text-xs font-mono whitespace-pre-wrap text-muted-foreground bg-muted/20 rounded border my-1">
        {cell.source}
      </pre>
    )
  }

  // Code cell — delegate to stateful component for collapse
  return (
    <IpynbCodeCell
      cell={cell}
      language={language}
      theme={theme}
      outputOnly={outputOnly}
      beforeMount={beforeMount}
    />
  )
}

// ---------------------------------------------------------------------------
// Code cell with auto-height and collapse/expand
// ---------------------------------------------------------------------------

function IpynbCodeCell({
  cell,
  language,
  theme,
  outputOnly,
  beforeMount,
}: {
  cell: IpynbCell
  language: string
  theme: string
  outputOnly: boolean
  beforeMount: BeforeMount
}) {
  const hasOutputs = cell.outputs && cell.outputs.length > 0

  // In output-only mode, hide code cells that have no outputs
  if (outputOnly && !hasOutputs) return null

  const lineCount = cell.source.split('\n').length
  const isLong = lineCount > COLLAPSE_LINE_THRESHOLD
  const [collapsed, setCollapsed] = useState(isLong)
  const [contentHeight, setContentHeight] = useState(Math.max(lineCount * 18 + 8, 36))
  const [copied, setCopied] = useState(false)

  const handleMount: OnMount = useCallback((editor) => {
    const updateHeight = () => {
      setContentHeight(Math.max(editor.getContentHeight(), 36))
    }
    editor.onDidContentSizeChange(updateHeight)
    updateHeight()
  }, [])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(cell.source)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [cell.source])

  const displayHeight = collapsed ? COLLAPSED_HEIGHT : contentHeight
  const execLabel =
    cell.execution_count != null ? `[${cell.execution_count}]` : '[ ]'

  return (
    <div className={cn('my-1 rounded border overflow-hidden group/code', 'bg-muted/20')}>
      {/* Code area — hidden in output-only mode */}
      {!outputOnly && (
        <div className="relative">
          {/* Copy button — top right */}
          <button
            onClick={handleCopy}
            className="absolute top-1 right-1 z-10 p-1 rounded bg-muted/80 border border-border/50 text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent opacity-0 group-hover/code:opacity-100 transition-opacity"
            title="Copy code"
          >
            {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
          </button>

          <div className="flex">
            {/* Execution count gutter */}
            <div className="flex-none w-12 py-1 text-right pr-2 text-[10px] font-mono text-muted-foreground/60 select-none pt-2">
              {execLabel}
            </div>
            {/* Monaco editor */}
            <div
              className="flex-1 min-w-0 overflow-hidden transition-[height] duration-200"
              style={{ height: displayHeight }}
            >
              <Editor
                value={cell.source}
                language={toMonacoLang(language)}
                theme={theme}
                options={READONLY_EDITOR_OPTIONS}
                beforeMount={beforeMount}
                onMount={handleMount}
                loading={
                  <pre className="text-xs font-mono p-2 whitespace-pre-wrap">
                    {cell.source}
                  </pre>
                }
              />
            </div>
          </div>

          {/* Collapse/expand toggle */}
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
      )}

      {/* Outputs */}
      {hasOutputs && (
        <div className={cn(
          'space-y-1 px-2 py-1',
          !outputOnly && 'border-t',
        )}>
          {cell.outputs!.map((output, oi) => (
            <IpynbOutputRenderer key={oi} output={output} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Output renderer (mime-bundle priority)
// ---------------------------------------------------------------------------

function IpynbOutputRenderer({ output }: { output: IpynbOutput }) {
  if (output.output_type === 'stream') {
    const isStderr = output.name === 'stderr'
    return (
      <CollapsiblePre
        className={isStderr
          ? 'text-red-600 dark:text-red-400 bg-red-500/5'
          : 'text-muted-foreground bg-muted/30'
        }
      >
        {output.text}
      </CollapsiblePre>
    )
  }

  if (output.output_type === 'error') {
    const trace = output.traceback?.join('\n') ?? `${output.ename}: ${output.evalue}`
    return (
      <CollapsiblePre className="text-red-600 dark:text-red-400 bg-red-500/5">
        {trace}
      </CollapsiblePre>
    )
  }

  // execute_result or display_data — render richest mime type
  const data = output.data
  if (!data) return null

  // Priority: image/png > image/jpeg > image/svg+xml > text/html > text/plain
  if (data['image/png']) {
    return (
      <ImageOutput
        src={`data:image/png;base64,${data['image/png']}`}
        alt="Output"
      />
    )
  }

  if (data['image/jpeg']) {
    return (
      <ImageOutput
        src={`data:image/jpeg;base64,${data['image/jpeg']}`}
        alt="Output"
      />
    )
  }

  if (data['image/svg+xml']) {
    return (
      <ImageOutput
        svgHtml={data['image/svg+xml']}
        alt="Output"
      />
    )
  }

  if (data['text/html']) {
    // Detect DataFrame tables (pandas, R) — render natively instead of iframe
    const dfTable = parseDataFrameHtml(data['text/html'])
    if (dfTable) {
      return <DataFrameTable headers={dfTable.headers} rows={dfTable.rows} index={dfTable.index} />
    }
    return <IpynbHtmlOutput html={data['text/html']} />
  }

  if (data['text/plain']) {
    return (
      <CollapsiblePre className="text-muted-foreground bg-muted/30">
        {data['text/plain']}
      </CollapsiblePre>
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// Collapsible <pre> for long text outputs
// ---------------------------------------------------------------------------

const PRE_LINE_COLLAPSE_THRESHOLD = 30
const PRE_COLLAPSED_LINES = 15

function CollapsiblePre({ children, className }: { children?: string; className?: string }) {
  const text = children ?? ''
  const lineCount = text.split('\n').length
  const isLong = lineCount > PRE_LINE_COLLAPSE_THRESHOLD
  const [collapsed, setCollapsed] = useState(isLong)

  const displayText = collapsed
    ? text.split('\n').slice(0, PRE_COLLAPSED_LINES).join('\n')
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
// HTML output with auto-height iframe + collapse/expand
// ---------------------------------------------------------------------------

const HTML_COLLAPSE_THRESHOLD = 300

function IpynbHtmlOutput({ html }: { html: string }) {
  const [iframeHeight, setIframeHeight] = useState(200)
  const [collapsed, setCollapsed] = useState(false)
  const isLong = iframeHeight > HTML_COLLAPSE_THRESHOLD
  const hasAutoCollapsed = useRef(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const measureIframe = useCallback((iframe: HTMLIFrameElement) => {
    try {
      const h = iframe.contentDocument?.documentElement?.scrollHeight
      if (h && h > 10) {
        const newH = h + 10
        setIframeHeight(newH)
        if (!hasAutoCollapsed.current && newH > HTML_COLLAPSE_THRESHOLD) {
          setCollapsed(true)
          hasAutoCollapsed.current = true
        }
      }
    } catch {
      // cross-origin — ignore
    }
  }, [])

  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLIFrameElement>) => {
    const iframe = e.currentTarget
    measureIframe(iframe)
    // Retry after a short delay for content that renders asynchronously (scripts, styles)
    setTimeout(() => measureIframe(iframe), 200)
    setTimeout(() => measureIframe(iframe), 800)
  }, [measureIframe])

  return (
    <div className="relative group/html rounded overflow-hidden">
      {/* Collapse/expand button — top right */}
      {isLong && (
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="absolute top-1 right-1 z-10 p-1 rounded bg-muted/80 border border-border/50 text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent opacity-0 group-hover/html:opacity-100 transition-opacity"
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <ChevronsUpDown size={12} />
        </button>
      )}

      <div
        className="overflow-hidden transition-[height] duration-200"
        style={{ height: collapsed ? HTML_COLLAPSE_THRESHOLD : iframeHeight }}
      >
        <iframe
          ref={iframeRef}
          srcDoc={html}
          className="w-full border-0 bg-white dark:bg-zinc-900"
          sandbox="allow-scripts"
          title="Cell output"
          style={{ height: iframeHeight, minHeight: 60 }}
          onLoad={handleLoad}
        />
      </div>

      {/* Collapsed fade + label */}
      {isLong && collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          className="flex items-center justify-center gap-1 w-full py-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent/30 transition-colors border-t border-dashed"
        >
          <ChevronsUpDown size={10} />
          Expand output
        </button>
      )}
      {isLong && !collapsed && (
        <button
          onClick={() => setCollapsed(true)}
          className="flex items-center justify-center gap-1 w-full py-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent/30 transition-colors border-t border-dashed"
        >
          <ChevronsUpDown size={10} />
          Collapse
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DataFrame HTML parser — detects pandas/R HTML tables
// ---------------------------------------------------------------------------

interface ParsedDataFrame {
  headers: string[]
  rows: string[][]
  index: string[]
}

function parseDataFrameHtml(html: string): ParsedDataFrame | null {
  // Quick check: must contain "dataframe" class (pandas) or be a simple table
  if (!html.includes('dataframe') && !html.includes('<table')) return null

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    const table = doc.querySelector('table.dataframe') ?? doc.querySelector('table')
    if (!table) return null

    // Only handle if there's a single table and not much else
    // Strip <style>, <table>, wrapper <div> tags, then check remaining text
    const stripped = html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<table[\s\S]*?<\/table>/gi, '')
      .replace(/<\/?div[^>]*>/gi, '')
      .replace(/<[^>]*>/g, '')
      .trim()
    if (stripped.length > 50) return null

    const thead = table.querySelector('thead')
    const tbody = table.querySelector('tbody')
    if (!thead || !tbody) return null

    // Parse headers — last row of thead if multiple (multi-index)
    const headerRows = thead.querySelectorAll('tr')
    const lastHeaderRow = headerRows[headerRows.length - 1]
    const headerCells = lastHeaderRow.querySelectorAll('th, td')
    const headers: string[] = []
    // First th in header row is often the index name — skip if empty
    let skipFirst = false
    if (headerCells.length > 0) {
      const firstText = headerCells[0].textContent?.trim() ?? ''
      if (firstText === '' || firstText === 'Unnamed: 0') skipFirst = true
    }
    for (let i = skipFirst ? 1 : 0; i < headerCells.length; i++) {
      headers.push(headerCells[i].textContent?.trim() ?? '')
    }

    // Parse body rows
    const bodyRows = tbody.querySelectorAll('tr')
    const rows: string[][] = []
    const index: string[] = []
    for (const tr of bodyRows) {
      const cells = tr.querySelectorAll('th, td')
      const row: string[] = []
      let rowIdx = ''
      for (let i = 0; i < cells.length; i++) {
        const text = cells[i].textContent?.trim() ?? ''
        // First cell is often a <th> index
        if (i === 0 && cells[i].tagName === 'TH') {
          rowIdx = text
        } else {
          row.push(text)
        }
      }
      // If no <th> index, first cell is data — only skip if we skipFirst
      if (rowIdx === '' && skipFirst && cells.length > 0) {
        // re-extract: first td as index
        rowIdx = cells[0].textContent?.trim() ?? ''
        row.length = 0
        for (let i = 1; i < cells.length; i++) {
          row.push(cells[i].textContent?.trim() ?? '')
        }
      }
      index.push(rowIdx)
      rows.push(row)
    }

    if (headers.length === 0 || rows.length === 0) return null
    return { headers, rows, index }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Native DataFrame table renderer (replaces iframe for pandas/R tables)
// ---------------------------------------------------------------------------

const DF_COLLAPSED_ROWS = 15

function DataFrameTable({ headers, rows, index }: ParsedDataFrame) {
  const isLong = rows.length > DF_COLLAPSED_ROWS
  const [collapsed, setCollapsed] = useState(isLong)
  const displayRows = collapsed ? rows.slice(0, DF_COLLAPSED_ROWS) : rows
  const displayIndex = collapsed ? index.slice(0, DF_COLLAPSED_ROWS) : index
  const hasIndex = index.some((v) => v !== '')

  return (
    <div className="relative group/df">
      {isLong && (
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="absolute top-1 right-1 z-10 p-1 rounded bg-muted/80 border border-border/50 text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent opacity-0 group-hover/df:opacity-100 transition-opacity"
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <ChevronsUpDown size={12} />
        </button>
      )}
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {hasIndex && (
                <th className="px-2 py-1 text-left text-muted-foreground font-medium border-b border-r bg-muted/80" />
              )}
              {headers.map((h, i) => (
                <th
                  key={i}
                  className="px-2 py-1 text-left font-medium border-b whitespace-nowrap"
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
                className={cn(
                  'border-b border-border/50 hover:bg-accent/30',
                  ri % 2 === 1 && 'bg-muted/20',
                )}
              >
                {hasIndex && (
                  <td className="px-2 py-0.5 text-muted-foreground font-medium border-r bg-muted/10 whitespace-nowrap">
                    {displayIndex[ri]}
                  </td>
                )}
                {row.map((val, ci) => (
                  <td key={ci} className="px-2 py-0.5 whitespace-nowrap">
                    {val}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Footer: row count + collapse toggle */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground/60 px-2 py-0.5">
        <span>{rows.length} rows × {headers.length} columns</span>
        {isLong && (
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="flex items-center gap-1 hover:text-muted-foreground transition-colors"
          >
            <ChevronsUpDown size={10} />
            {collapsed ? `Show all (${rows.length} rows)` : 'Collapse'}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Image output with zoomable lightbox
// ---------------------------------------------------------------------------

const ZOOM_MIN = 0.25
const ZOOM_MAX = 5
const ZOOM_STEP = 0.25
const ZOOM_WHEEL_STEP = 0.15

function ImageOutput({ src, svgHtml, alt }: { src?: string; svgHtml?: string; alt: string }) {
  const [open, setOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const isPanning = useRef(false)
  const panStart = useRef({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)

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
      <div className="relative group/img flex justify-center py-1">
        {svgHtml ? (
          <div
            className="max-w-full cursor-pointer [&>svg]:max-w-full [&>svg]:max-h-96"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(svgHtml) }}
            onClick={() => { resetView(); setOpen(true) }}
          />
        ) : (
          <img
            src={src}
            alt={alt}
            className="max-w-full max-h-96 object-contain cursor-pointer"
            onClick={() => { resetView(); setOpen(true) }}
          />
        )}
        <button
          onClick={() => { resetView(); setOpen(true) }}
          className="absolute top-2 right-2 p-1 rounded bg-muted/80 border border-border/50 text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent opacity-0 group-hover/img:opacity-100 transition-opacity"
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
            ref={containerRef}
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
              {svgHtml ? (
                <div
                  className="[&>svg]:max-w-full [&>svg]:max-h-[calc(98vh-3rem)] [&>svg]:object-contain pointer-events-none"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(svgHtml) }}
                />
              ) : (
                <img
                  src={src}
                  alt={alt}
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
