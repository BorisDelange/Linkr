import { describe, expect, it } from 'vitest'
import { conversationTitle, savingEnabled } from './conversations'
import type { TranscriptEntry } from '@/stores/agent-session-store'

function entry(overrides: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: 'e1', kind: 'user', text: '', at: 0, ...overrides }
}

describe('savingEnabled', () => {
  it('defaults to on when the user never chose', () => {
    expect(savingEnabled(undefined)).toBe(true)
    expect(savingEnabled({})).toBe(true)
  })

  it('is off only when explicitly set to false', () => {
    expect(savingEnabled({ saveConversations: false })).toBe(false)
    expect(savingEnabled({ saveConversations: true })).toBe(true)
  })

  it('treats a missing key among other preferences as on', () => {
    // A partial preferences object must not read as a refusal to save.
    expect(savingEnabled({ assistantModel: 'qwen3.5:4b' })).toBe(true)
  })
})

describe('conversationTitle', () => {
  it('uses the first user turn', () => {
    const title = conversationTitle([
      entry({ text: 'Ajoute un onglet Test' }),
      entry({ id: 'e2', kind: 'assistant', text: 'Done' }),
      entry({ id: 'e3', kind: 'user', text: 'Et un widget' }),
    ])
    expect(title).toBe('Ajoute un onglet Test')
  })

  it('skips leading assistant or tool entries', () => {
    const title = conversationTitle([
      entry({ kind: 'tool', text: 'add_tab' }),
      entry({ id: 'e2', kind: 'user', text: 'Crée un histogramme' }),
    ])
    expect(title).toBe('Crée un histogramme')
  })

  it('collapses whitespace so a pasted multi-line prompt stays one line', () => {
    expect(conversationTitle([entry({ text: '  Ajoute\n\n  un   onglet  ' })])).toBe(
      'Ajoute un onglet'
    )
  })

  it('truncates a long prompt with an ellipsis', () => {
    const title = conversationTitle([entry({ text: 'a'.repeat(200) })])
    expect(title).toHaveLength(80)
    expect(title.endsWith('…')).toBe(true)
  })

  it('returns an empty title when there is no user turn', () => {
    expect(conversationTitle([])).toBe('')
    expect(conversationTitle([entry({ kind: 'assistant', text: 'hello' })])).toBe('')
  })
})
