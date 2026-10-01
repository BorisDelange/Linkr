import { describe, expect, it } from 'vitest'
import { clipForTooltip } from './truncated-text'

describe('clipForTooltip', () => {
  it('leaves a short text whole', () => {
    expect(clipForTooltip('SELECT 1')).toBe('SELECT 1')
  })

  it('cuts a long text and marks the cut', () => {
    const out = clipForTooltip('x'.repeat(2000), 500)
    expect(out).toBe(`${'x'.repeat(500)} …`)
  })

  it('cuts a text of many short lines', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    expect(clipForTooltip(text, 500, 3)).toBe('line 0\nline 1\nline 2 …')
  })
})
