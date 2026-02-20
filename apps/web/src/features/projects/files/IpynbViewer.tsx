/**
 * Read-only Jupyter Notebook (.ipynb) viewer.
 *
 * Renders notebook cells with:
 * - Monaco read-only for code cells (syntax highlighted)
 * - MarkdownRenderer for markdown cells
 * - Inline outputs (images, HTML, tables, errors)
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Editor from '@monaco-editor/react'
import { Info } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppStore } from '@/stores/app-store'
import {
  parseIpynbFile,
  getNotebookLanguage,
  type IpynbCell,
  type IpynbOutput,
} from '@/lib/ipynb-parser'

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
  scrollbar: { vertical: 'hidden' as const, horizontal: 'auto' as const },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  padding: { top: 4, bottom: 4 },
  contextmenu: false,
  wordWrap: 'on' as const,
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
    ? darkMode ? 'vs-dark' : 'vs'
    : editorTheme

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
    <ScrollArea className="h-full">
      <div className="max-w-4xl mx-auto py-4 px-4 space-y-0">
        {/* Read-only banner */}
        <div className="flex items-center gap-2 rounded-md bg-muted/50 border px-3 py-2 mb-4 text-xs text-muted-foreground">
          <Info size={14} className="shrink-0" />
          {t('files.ipynb_readonly_notice')}
        </div>

        {notebook.cells.map((cell, idx) => (
          <IpynbCellRenderer
            key={idx}
            cell={cell}
            language={language}
            theme={resolvedTheme}
          />
        ))}
      </div>
    </ScrollArea>
  )
}

// ---------------------------------------------------------------------------
// Cell renderer
// ---------------------------------------------------------------------------

function IpynbCellRenderer({
  cell,
  language,
  theme,
}: {
  cell: IpynbCell
  language: string
  theme: string
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
    return (
      <pre className="py-2 px-3 text-xs font-mono whitespace-pre-wrap text-muted-foreground bg-muted/20 rounded border my-1">
        {cell.source}
      </pre>
    )
  }

  // Code cell
  const lineCount = cell.source.split('\n').length
  const height = Math.max(lineCount * 18 + 8, 36)
  const execLabel =
    cell.execution_count != null ? `[${cell.execution_count}]` : '[ ]'

  return (
    <div className="my-1 rounded border bg-muted/20 overflow-hidden">
      {/* Code area */}
      <div className="flex">
        {/* Execution count gutter */}
        <div className="flex-none w-12 py-1 text-right pr-2 text-[10px] font-mono text-muted-foreground/60 select-none pt-2">
          {execLabel}
        </div>
        {/* Monaco editor */}
        <div className="flex-1 min-w-0" style={{ height }}>
          <Editor
            value={cell.source}
            language={toMonacoLang(language)}
            theme={theme}
            options={READONLY_EDITOR_OPTIONS}
            loading={
              <pre className="text-xs font-mono p-2 whitespace-pre-wrap">
                {cell.source}
              </pre>
            }
          />
        </div>
      </div>

      {/* Outputs */}
      {cell.outputs && cell.outputs.length > 0 && (
        <div className="border-t space-y-1 px-2 py-1">
          {cell.outputs.map((output, oi) => (
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
      <pre
        className={`text-xs font-mono whitespace-pre-wrap px-2 py-1 rounded max-h-48 overflow-y-auto ${
          isStderr
            ? 'text-red-600 dark:text-red-400 bg-red-500/5'
            : 'text-muted-foreground bg-muted/30'
        }`}
      >
        {output.text}
      </pre>
    )
  }

  if (output.output_type === 'error') {
    const trace = output.traceback?.join('\n') ?? `${output.ename}: ${output.evalue}`
    return (
      <pre className="text-xs font-mono whitespace-pre-wrap text-red-600 dark:text-red-400 px-2 py-1 bg-red-500/5 rounded max-h-64 overflow-y-auto">
        {trace}
      </pre>
    )
  }

  // execute_result or display_data — render richest mime type
  const data = output.data
  if (!data) return null

  // Priority: image/png > image/jpeg > image/svg+xml > text/html > text/plain
  if (data['image/png']) {
    return (
      <div className="flex justify-center py-1">
        <img
          src={`data:image/png;base64,${data['image/png']}`}
          alt="Output"
          className="max-w-full max-h-96 object-contain"
        />
      </div>
    )
  }

  if (data['image/jpeg']) {
    return (
      <div className="flex justify-center py-1">
        <img
          src={`data:image/jpeg;base64,${data['image/jpeg']}`}
          alt="Output"
          className="max-w-full max-h-96 object-contain"
        />
      </div>
    )
  }

  if (data['image/svg+xml']) {
    return (
      <div
        className="flex justify-center py-1 [&>svg]:max-w-full [&>svg]:max-h-96"
        dangerouslySetInnerHTML={{ __html: data['image/svg+xml'] }}
      />
    )
  }

  if (data['text/html']) {
    return (
      <iframe
        srcDoc={data['text/html']}
        className="w-full border-0 rounded bg-white dark:bg-zinc-900"
        sandbox="allow-scripts"
        title="Cell output"
        style={{ minHeight: 60, maxHeight: 400 }}
        onLoad={(e) => {
          // Auto-resize iframe to fit content
          const iframe = e.currentTarget
          try {
            const h = iframe.contentDocument?.documentElement?.scrollHeight
            if (h) iframe.style.height = `${Math.min(h + 10, 400)}px`
          } catch {
            // cross-origin — ignore
          }
        }}
      />
    )
  }

  if (data['text/plain']) {
    return (
      <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground px-2 py-1 bg-muted/30 rounded max-h-48 overflow-y-auto">
        {data['text/plain']}
      </pre>
    )
  }

  return null
}
