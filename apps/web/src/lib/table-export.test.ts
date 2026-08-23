import { describe, it, expect } from 'vitest'
import { escapeLatex, toLatex, toTsv, toHtml, type ExportTable } from './table-export'

/** A Table 1 with a group header and one indented categorical level. */
const table: ExportTable = {
  head: [
    [
      { text: '', colSpan: 1 },
      { text: 'Control (n=137)', colSpan: 2, align: 'center' },
      { text: 'Case (n=44)', colSpan: 2, align: 'center' },
    ],
    [
      { text: 'Variable', align: 'left' },
      { text: 'n', align: 'right' },
      { text: '%', align: 'right' },
      { text: 'n', align: 'right' },
      { text: '%', align: 'right' },
    ],
  ],
  body: [
    [
      { text: 'Service type', align: 'left' },
      { text: '', align: 'right' },
      { text: '', align: 'right' },
      { text: '', align: 'right' },
      { text: '', align: 'right' },
    ],
    [
      { text: 'ICU', align: 'left' },
      { text: '44', align: 'right' },
      { text: '32', align: 'right' },
      { text: '12', align: 'right' },
      { text: '27', align: 'right' },
    ],
  ],
  indentedRows: new Set([1]),
  caption: 'Baseline characteristics',
}

describe('escapeLatex', () => {
  it('escapes the characters LaTeX reads as markup', () => {
    expect(escapeLatex('50% of a & b')).toBe('50\\% of a \\& b')
    expect(escapeLatex('cost_$100')).toBe('cost\\_\\$100')
    expect(escapeLatex('a{b}c')).toBe('a\\{b\\}c')
  })

  it('escapes a backslash without then escaping its own replacement', () => {
    // The naive order turns `\` into `\textbackslash{}` and then escapes the
    // braces it just introduced, yielding `\textbackslash\{\}`.
    expect(escapeLatex('a\\b')).toBe('a\\textbackslash{}b')
  })
})

describe('toLatex', () => {
  const out = toLatex(table)

  it('uses booktabs rules and never \\hline', () => {
    expect(out).toContain('\\toprule')
    expect(out).toContain('\\midrule')
    expect(out).toContain('\\bottomrule')
    expect(out).not.toContain('\\hline')
  })

  it('declares no vertical rules — the point of booktabs', () => {
    const spec = out.match(/\\begin\{tabular\}\{([^}]*)\}/)![1]
    expect(spec).not.toContain('|')
    expect(spec).toBe('lrrrr')
  })

  it('spans a group header and rules only its own columns', () => {
    expect(out).toContain('\\multicolumn{2}{c}{Control (n=137)}')
    // Control covers columns 2-3, Case 4-5. The empty leading cell gets none.
    expect(out).toContain('\\cmidrule(lr){2-3}')
    expect(out).toContain('\\cmidrule(lr){4-5}')
  })

  it('typesets the indent instead of using spaces LaTeX would collapse', () => {
    expect(out).toContain('\\hspace{1em}ICU')
    expect(out).not.toMatch(/^ +ICU/m)
  })

  it('emits the caption', () => {
    expect(out).toContain('\\caption{Baseline characteristics}')
  })

  it('returns nothing rather than a broken environment for an empty table', () => {
    expect(toLatex({ head: [], body: [] })).toBe('')
  })
})

describe('toTsv', () => {
  const out = toTsv(table)

  it('pads a spanning label so the columns still line up', () => {
    // "Control" spans 2, so it must be followed by one empty cell, not sit
    // directly beside "Case" — otherwise a paste into a sheet is shifted.
    expect(out.split('\n')[0]).toBe('\tControl (n=137)\t\tCase (n=44)\t')
  })

  it('keeps one row per line with tab separators', () => {
    const lines = out.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe('    ICU\t44\t32\t12\t27')
  })
})

describe('toHtml', () => {
  const out = toHtml(table)

  it('carries its rules inline, since a paste keeps no stylesheet', () => {
    expect(out).toContain('border-collapse:collapse')
    expect(out).toContain('border-top:1.5pt solid black')
    expect(out).toContain('border-bottom:1.5pt solid black')
  })

  it('escapes HTML rather than emitting raw markup', () => {
    const risky = toHtml({
      head: [],
      body: [[{ text: '<script>alert(1)</script>' }]],
    })
    expect(risky).not.toContain('<script>')
    expect(risky).toContain('&lt;script&gt;')
  })

  it('spans group headers with colspan', () => {
    expect(out).toContain('colspan="2"')
  })

  it('indents a level with padding, which survives a paste', () => {
    expect(out).toContain('padding-left:24px')
  })
})

describe('toLatex preamble', () => {
  const table: ExportTable = {
    head: [[{ text: 'Variable' }, { text: 'Overall' }]],
    body: [[{ text: 'age' }, { text: '61' }]],
  }

  it('names the packages the fragment needs, as a comment', () => {
    // Pasted into an existing manuscript, a real \usepackage in the body would
    // be an error — but the reader still has to know booktabs is required.
    const out = toLatex(table)
    expect(out).toMatch(/^% Requires in your preamble: \\usepackage\{booktabs\}/)
    expect(out).toContain('\\begin{table}')
    expect(out).not.toContain('\\begin{document}')
  })

  it('standalone compiles on its own: class, packages, document', () => {
    const out = toLatex(table, { standalone: true })
    expect(out).toContain('\\documentclass{article}')
    expect(out).toContain('\\usepackage{booktabs}')
    expect(out.indexOf('\\begin{document}')).toBeLessThan(out.indexOf('\\begin{table}'))
    expect(out.indexOf('\\end{table}')).toBeLessThan(out.indexOf('\\end{document}'))
    expect(out).not.toContain('% Requires')
  })
})
