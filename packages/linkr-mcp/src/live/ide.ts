/** Pure helpers for IDE scripts and code runs. */

export type RunLanguage = 'python' | 'r'

export interface ExecutionOutput {
  stdout: string
  stderr: string
  figures: { id: string; type: string; data: string; label: string }[]
  table: { headers: string[]; rows: unknown[][] } | null
  html: string | null
  failed?: boolean
}

/** The language a script runs in, from its extension; null when it is not runnable here. */
export function runLanguageFor(path: string): RunLanguage | null {
  const ext = path.toLowerCase().split('.').pop()
  if (ext === 'py') return 'python'
  if (ext === 'r') return 'r'
  return null
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (${text.length - max} more characters cut)`
}

/**
 * A run's output as text for the model: stdout, stderr, the table and what else
 * came back, each cut to a budget so one noisy print cannot flood the context.
 */
export function formatExecution(out: ExecutionOutput, maxChars = 6000): string {
  const parts = [out.failed ? 'The code raised an error.' : 'Ran successfully.']
  if (out.stdout.trim()) parts.push(`stdout:\n${clip(out.stdout.trimEnd(), maxChars)}`)
  if (out.stderr.trim()) parts.push(`stderr:\n${clip(out.stderr.trimEnd(), Math.floor(maxChars / 2))}`)
  if (out.table) {
    const rows = out.table.rows.slice(0, 30).map((r) => r.map((c) => String(c ?? '')).join(' | '))
    const more = out.table.rows.length > 30 ? `\n… ${out.table.rows.length - 30} more row(s)` : ''
    parts.push(`table:\n${out.table.headers.join(' | ')}\n${rows.join('\n')}${more}`)
  }
  if (out.figures.length) parts.push(`${out.figures.length} figure(s), shown to the user.`)
  if (out.html) parts.push('An HTML output was produced (not shown here).')
  if (parts.length === 1) parts.push('(no output)')
  return parts.join('\n\n')
}

/** Script files as an indented tree, folders first. */
export function renderScriptTree(nodes: { path: string; type: 'file' | 'folder'; content?: string | null }[]): string {
  if (nodes.length === 0) return '(no script)'
  return [...nodes]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((n) => {
      const depth = n.path.split('/').length - 1
      const name = n.path.split('/').pop()
      const size = n.type === 'file' ? ` (${(n.content ?? '').split('\n').length} lines)` : '/'
      return `${'  '.repeat(depth)}${name}${size}`
    })
    .join('\n')
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** A run's figures as one self-contained HTML page, for the chat to render. SVG
 *  arrives as markup, PNG as base64 (or a data URL). */
export function figuresHtml(figures: ExecutionOutput['figures']): string {
  const items = figures.map((f) => {
    const body = f.type === 'svg'
      ? f.data
      : `<img alt="${escapeHtml(f.label)}" src="${f.data.startsWith('data:') ? f.data : `data:image/png;base64,${f.data}`}">`
    return `<figure>${body}${f.label ? `<figcaption>${escapeHtml(f.label)}</figcaption>` : ''}</figure>`
  })
  return '<!doctype html><html><head><meta charset="utf-8"><style>'
    + 'body{margin:0;padding:8px;background:#fff;font:12px system-ui,sans-serif;color:#555}'
    + 'figure{margin:0 0 12px}figure svg,figure img{max-width:100%;height:auto}figcaption{margin-top:4px}'
    + `</style></head><body>${items.join('')}</body></html>`
}
