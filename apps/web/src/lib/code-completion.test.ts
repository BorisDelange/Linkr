import { describe, it, expect } from 'vitest'
import { rCompletionItems, rCompletionLabel } from './code-completion'

describe('rCompletionLabel', () => {
  it('shows only what follows the accessor', () => {
    expect(rCompletionLabel('df$age_years')).toBe('age_years')
    expect(rCompletionLabel('stats::median')).toBe('median')
    expect(rCompletionLabel('pkg:::hidden')).toBe('hidden')
    expect(rCompletionLabel('obj@slot')).toBe('slot')
    expect(rCompletionLabel('mean')).toBe('mean')
  })
})

describe('rCompletionItems', () => {
  it('inserts the whole completion over the token R read, and tags calls and arguments', () => {
    expect(rCompletionItems('df$ag', ['df$age', 'mean(', 'na.rm='])).toEqual([
      { label: 'age', insert: 'df$age', kind: '', typed: 5 },
      { label: 'mean(', insert: 'mean(', kind: 'function', typed: 5 },
      { label: 'na.rm=', insert: 'na.rm=', kind: 'argument', typed: 5 },
    ])
  })
})
