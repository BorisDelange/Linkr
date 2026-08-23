/**
 * Turning a rendered table into something you can paste into a manuscript.
 *
 * Three targets, because they are pasted into different places:
 *  - HTML, which is what Word and Google Docs accept as a real table;
 *  - tab-separated text, the plain-text fallback and what a spreadsheet reads;
 *  - LaTeX `booktabs`, which is the source form of the style the table is drawn
 *    in (docs/planning/descriptive-table-plan.md §3.1).
 *
 * Pure string work, kept out of the components so it can be tested directly.
 */

export interface ExportTableCell {
  text: string
  /** Columns this cell spans, for a group header. */
  colSpan?: number
  align?: 'left' | 'right' | 'center'
}

export interface ExportTable {
  /** Header rows, outermost first — a group row above a column row. */
  head: ExportTableCell[][]
  body: ExportTableCell[][]
  /** Rows that are a level of a categorical variable, indented under it. */
  indentedRows?: Set<number>
  caption?: string
}

/** Characters LaTeX reads as markup, and what each becomes. */
const LATEX_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
}

/**
 * Escape a string for LaTeX.
 *
 * One pass, not a chain of replacements: escaping `\` first produces
 * `\textbackslash{}`, whose braces a later brace rule would then escape in
 * turn, yielding `\textbackslash\{\}`. Replacing every character in a single
 * traversal never revisits its own output.
 */
export function escapeLatex(text: string): string {
  return text.replace(/[\\&%$#_{}~^]/g, (ch) => LATEX_ESCAPES[ch] ?? ch)
}

/**
 * A `booktabs` table.
 *
 * Rules are `\toprule` / `\midrule` / `\bottomrule` and never `\hline`, and
 * there are no vertical rules in the column spec — that is the whole point of
 * booktabs, and pasting in `|` separators is the classic way to undo it. A group
 * header gets a `\cmidrule` spanning only its own columns.
 */
export function toLatex(table: ExportTable): string {
  const columnCount = table.body[0]?.length ?? table.head[table.head.length - 1]?.length ?? 0
  if (columnCount === 0) return ''

  // Alignment from the body's first row: the header is often centred over
  // figures that are themselves right-aligned.
  const spec = (table.body[0] ?? []).map((c) =>
    c.align === 'right' ? 'r' : c.align === 'center' ? 'c' : 'l',
  ).join('')

  const lines: string[] = []
  lines.push('\\begin{table}[htbp]')
  lines.push('\\centering')
  if (table.caption) lines.push(`\\caption{${escapeLatex(table.caption)}}`)
  lines.push(`\\begin{tabular}{${spec || 'l'.repeat(columnCount)}}`)
  lines.push('\\toprule')

  table.head.forEach((row, rowIdx) => {
    const cells = row.map((c) => {
      const text = escapeLatex(c.text)
      if (!c.colSpan || c.colSpan === 1) return text
      const a = c.align === 'right' ? 'r' : c.align === 'left' ? 'l' : 'c'
      return `\\multicolumn{${c.colSpan}}{${a}}{${text}}`
    })
    lines.push(`${cells.join(' & ')} \\\\`)

    // A cmidrule under each spanning label, covering only its columns.
    const rules: string[] = []
    let col = 1
    for (const c of row) {
      const span = c.colSpan ?? 1
      if (span > 1 && c.text.trim()) rules.push(`\\cmidrule(lr){${col}-${col + span - 1}}`)
      col += span
    }
    if (rules.length > 0) lines.push(rules.join(' '))
    else if (rowIdx === table.head.length - 1) lines.push('\\midrule')
  })
  if (table.head.length === 0) lines.push('\\midrule')

  table.body.forEach((row, i) => {
    const cells = row.map((c, ci) => {
      const text = escapeLatex(c.text)
      // Indentation is typeset, not spaces: \hspace survives reflow, leading
      // spaces in a LaTeX cell are collapsed away.
      return ci === 0 && table.indentedRows?.has(i) ? `\\hspace{1em}${text}` : text
    })
    lines.push(`${cells.join(' & ')} \\\\`)
  })

  lines.push('\\bottomrule')
  lines.push('\\end{tabular}')
  lines.push('\\end{table}')
  return lines.join('\n')
}

/** Tab-separated text: the plain-text clipboard flavour, and what a spreadsheet reads. */
export function toTsv(table: ExportTable): string {
  const rows: string[] = []
  for (const row of table.head) {
    // A spanning label occupies its first column and leaves the rest empty, so
    // the columns still line up when pasted into a sheet.
    const cells: string[] = []
    for (const c of row) {
      cells.push(c.text)
      for (let i = 1; i < (c.colSpan ?? 1); i++) cells.push('')
    }
    rows.push(cells.join('\t'))
  }
  table.body.forEach((row, i) => {
    const cells = row.map((c, ci) =>
      ci === 0 && table.indentedRows?.has(i) ? `    ${c.text}` : c.text,
    )
    rows.push(cells.join('\t'))
  })
  return rows.join('\n')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * An HTML table, which is what Word and Google Docs paste as a real table.
 *
 * Styling is inline: a pasted table keeps no stylesheet, so the booktabs rules
 * have to travel as attributes or they are lost on arrival.
 */
export function toHtml(table: ExportTable): string {
  const rule = 'border-top:1.5pt solid black'
  const thin = 'border-bottom:0.75pt solid black'
  const rows: string[] = []

  table.head.forEach((row, i) => {
    const cells = row.map((c) => {
      const align = c.align ?? 'center'
      const border = c.colSpan && c.colSpan > 1 && c.text.trim() ? `;${thin}` : ''
      const top = i === 0 ? `;${rule}` : ''
      return `<th colspan="${c.colSpan ?? 1}" style="text-align:${align};padding:2px 8px${border}${top}">${escapeHtml(c.text)}</th>`
    })
    rows.push(`<tr>${cells.join('')}</tr>`)
  })

  table.body.forEach((row, i) => {
    const first = i === 0 ? `;border-top:1pt solid black` : ''
    const last = i === table.body.length - 1 ? `;border-bottom:1.5pt solid black` : ''
    const cells = row.map((c, ci) => {
      const align = c.align ?? 'left'
      const pad = ci === 0 && table.indentedRows?.has(i) ? 'padding-left:24px' : 'padding-left:8px'
      return `<td style="text-align:${align};${pad};padding-right:8px;padding-top:2px;padding-bottom:2px${first}${last}">${escapeHtml(c.text)}</td>`
    })
    rows.push(`<tr>${cells.join('')}</tr>`)
  })

  const caption = table.caption ? `<caption>${escapeHtml(table.caption)}</caption>` : ''
  return `<table style="border-collapse:collapse;font-family:sans-serif;font-size:10pt">${caption}${rows.join('')}</table>`
}

/**
 * Put the table on the clipboard as BOTH HTML and text.
 *
 * Both flavours in one write: the target decides which it takes, so Word gets a
 * real table while a plain-text editor gets readable columns. Falls back to
 * text alone where the async clipboard API is unavailable.
 */
export async function copyTableToClipboard(table: ExportTable): Promise<void> {
  const text = toTsv(table)
  const html = toHtml(table)
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ])
    return
  }
  await navigator.clipboard.writeText(text)
}
