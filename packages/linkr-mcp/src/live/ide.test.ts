import { describe, expect, it } from 'vitest'
import { figuresHtml, formatExecution, renderScriptTree, runLanguageFor } from './ide'

describe('runLanguageFor', () => {
  it('maps runnable extensions and refuses the rest', () => {
    expect(runLanguageFor('analysis/model.py')).toBe('python')
    expect(runLanguageFor('report.R')).toBe('r')
    expect(runLanguageFor('notes.md')).toBeNull()
    expect(runLanguageFor('eda.Rmd')).toBeNull()
    expect(runLanguageFor('query.sql')).toBeNull()
  })
})

describe('formatExecution', () => {
  const base = { stdout: '', stderr: '', figures: [], table: null, html: null }

  it('reports output, errors, tables and figures', () => {
    const text = formatExecution({
      ...base, stdout: 'n = 42\n', failed: false,
      table: { headers: ['sex', 'n'], rows: [['F', 20], ['M', 22]] },
      figures: [{ id: 'fig-0', type: 'png', data: 'x', label: '' }],
    })
    expect(text).toContain('Ran successfully.')
    expect(text).toContain('stdout:\nn = 42')
    expect(text).toContain('sex | n\nF | 20\nM | 22')
    expect(text).toContain('1 figure(s)')
    expect(formatExecution({ ...base, stderr: 'Error: boom', failed: true })).toMatch(/^The code raised an error\.[\s\S]*boom/)
  })

  it('cuts long output and says how much', () => {
    const text = formatExecution({ ...base, stdout: 'x'.repeat(100) }, 10)
    expect(text).toContain('90 more characters cut')
    expect(formatExecution(base)).toContain('(no output)')
  })
})

describe('renderScriptTree', () => {
  it('indents by folder and counts lines', () => {
    expect(renderScriptTree([
      { path: 'analysis/model.py', type: 'file', content: 'a\nb' },
      { path: 'analysis', type: 'folder' },
    ])).toBe('analysis/\n  model.py (2 lines)')
  })
})

describe('figuresHtml', () => {
  it('inlines SVG markup and PNG data', () => {
    const html = figuresHtml([
      { id: 'fig-0', type: 'svg', data: '<svg id="a"></svg>', label: 'Figure <1>' },
      { id: 'fig-1', type: 'png', data: 'iVBOR', label: '' },
    ])
    expect(html).toContain('<svg id="a"></svg><figcaption>Figure &lt;1&gt;</figcaption>')
    expect(html).toContain('src="data:image/png;base64,iVBOR"')
  })
})
