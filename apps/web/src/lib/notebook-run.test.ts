import { describe, it, expect } from 'vitest'
import { runCellSequence, runnableCells, outputFailed } from './notebook-run'
import type { RmdCell } from '@/lib/rmd-parser'

function code(id: string, content = 'x'): RmdCell {
  return { id, type: 'code', content, language: 'r' }
}
function md(id: string, content = '# title'): RmdCell {
  return { id, type: 'markdown', content }
}

describe('runCellSequence', () => {
  it('runs every cell when none fails', async () => {
    const res = await runCellSequence(
      [code('a'), code('b'), code('c')],
      async () => true,
      () => {},
    )
    expect(res.ran).toEqual(['a', 'b', 'c'])
    expect(res.completed).toBe(true)
  })

  it('STOPS at the first failing cell — the ones after it never run', async () => {
    const res = await runCellSequence(
      [code('a'), code('boom'), code('c'), code('d')],
      async (cell) => cell.id !== 'boom',
      () => {},
    )
    expect(res.ran).toEqual(['a', 'boom'])
    expect(res.completed).toBe(false)
  })

  it('stops on the very first cell when that one fails', async () => {
    const res = await runCellSequence([code('a'), code('b')], async () => false, () => {})
    expect(res.ran).toEqual(['a'])
    expect(res.completed).toBe(false)
  })

  it('previews markdown cells without running them, and they never stop the run', async () => {
    const previewed: string[] = []
    const res = await runCellSequence(
      [md('m1'), code('a'), md('m2'), code('b')],
      async () => true,
      (cell) => previewed.push(cell.id),
    )
    expect(previewed).toEqual(['m1', 'm2'])
    expect(res.ran).toEqual(['a', 'b'])
    expect(res.completed).toBe(true)
  })

  it('stops as soon as the run is aborted', async () => {
    let aborted = false
    const res = await runCellSequence(
      [code('a'), code('b'), code('c')],
      async (cell) => {
        if (cell.id === 'b') aborted = true
        return true
      },
      () => {},
      () => aborted,
    )
    // 'b' ran and set the abort; 'c' is never started.
    expect(res.ran).toEqual(['a', 'b'])
    expect(res.completed).toBe(false)
  })

  it('does not start anything when aborted up front', async () => {
    const res = await runCellSequence([code('a')], async () => true, () => {}, () => true)
    expect(res.ran).toEqual([])
    expect(res.completed).toBe(false)
  })
})

describe('runnableCells', () => {
  it('keeps code and markdown, drops yaml and blanks', () => {
    const cells: RmdCell[] = [
      { id: 'y', type: 'yaml', content: 'title: x' },
      code('a'),
      code('blank', '   '),
      md('m'),
      md('empty', ''),
    ]
    expect(runnableCells(cells).map((c) => c.id)).toEqual(['a', 'm'])
  })
})

describe('outputFailed', () => {
  it('is true only when the engine reported a failure', () => {
    expect(outputFailed({ failed: true })).toBe(true)
    expect(outputFailed({ failed: false })).toBe(false)
    expect(outputFailed({})).toBe(false)
    expect(outputFailed(null)).toBe(false)
  })

  it('does NOT treat a warning on stderr as a failure', () => {
    // R writes warning()/message() to stderr on runs that succeeded — the whole
    // reason the verdict cannot be derived from stderr.
    const warned = { stderr: 'Warning message:\n  careful', failed: false }
    expect(outputFailed(warned)).toBe(false)
  })
})
