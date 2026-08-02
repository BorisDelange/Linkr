import { describe, it, expect } from 'vitest'
import { parseAnsi, stripAnsi } from './ansi'

describe('parseAnsi', () => {
  it('returns a single plain segment for text with no codes', () => {
    expect(parseAnsi('hello world')).toEqual([{ text: 'hello world' }])
  })

  it('colours a green checkmark then resets', () => {
    // The exact sequence renv emits: ESC[32m ✔ ESC[0m readr 2.2.0
    const segs = parseAnsi('\x1b[32m✔\x1b[0m readr 2.2.0')
    expect(segs).toEqual([
      { text: '✔', className: 'text-emerald-500' },
      { text: ' readr 2.2.0' },
    ])
  })

  it('treats an empty SGR (ESC[m) as a reset', () => {
    const segs = parseAnsi('\x1b[31mred\x1b[mplain')
    expect(segs).toEqual([
      { text: 'red', className: 'text-red-500' },
      { text: 'plain' },
    ])
  })

  it('tracks bold and clears it on code 22', () => {
    const segs = parseAnsi('\x1b[1mbold\x1b[22mnormal')
    expect(segs).toEqual([
      { text: 'bold', bold: true },
      { text: 'normal' },
    ])
  })

  it('ignores unknown codes but keeps their text', () => {
    // 38;5;208 (256-colour) is unsupported — text survives, uncoloured.
    const segs = parseAnsi('\x1b[38;5;208mtext')
    expect(segs).toEqual([{ text: 'text' }])
  })

  it('drops empty runs between adjacent codes', () => {
    const segs = parseAnsi('\x1b[32m\x1b[1mx')
    expect(segs).toEqual([{ text: 'x', className: 'text-emerald-500', bold: true }])
  })

  it('drops cursor hide/show sequences (ESC[?25l / ESC[?25h) that would print literally', () => {
    const segs = parseAnsi('\x1b[?25lRunning\x1b[?25h done')
    expect(segs).toEqual([{ text: 'Running done' }])
  })

  it('drops erase-line and cursor-move sequences from progress-bar output', () => {
    // A uv/pip-style redraw: clear line, move to column 1, then coloured text.
    const segs = parseAnsi('\x1b[2K\x1b[1G\x1b[32mResolved\x1b[0m 12 packages')
    expect(segs).toEqual([
      { text: 'Resolved', className: 'text-emerald-500' },
      { text: ' 12 packages' },
    ])
  })
})

describe('stripAnsi', () => {
  it('removes all SGR codes', () => {
    expect(stripAnsi('\x1b[32m✔\x1b[0m done')).toBe('✔ done')
  })

  it('removes cursor/erase control sequences too', () => {
    expect(stripAnsi('\x1b[?25l\x1b[2Kbuilding\x1b[?25h')).toBe('building')
  })
})
