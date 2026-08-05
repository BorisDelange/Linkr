import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_NOTES,
  addNote,
  loadMemory,
  memoryContext,
  removeNote,
  saveMemory,
} from './memory'

beforeAll(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
})

beforeEach(() => localStorage.clear())

describe('memory', () => {
  it('starts empty', () => {
    expect(loadMemory('dash_1')).toEqual([])
  })

  it('stores notes per dashboard', () => {
    addNote('dash_1', 'Always use histograms')
    addNote('dash_2', 'Prefer boxplots')
    expect(loadMemory('dash_1')).toEqual(['Always use histograms'])
    expect(loadMemory('dash_2')).toEqual(['Prefer boxplots'])
  })

  it('removes a note by index', () => {
    addNote('dash_1', 'first')
    addNote('dash_1', 'second')
    expect(removeNote('dash_1', 0)).toEqual(['second'])
  })

  it('caps the number of notes, since they are re-sent every request', () => {
    for (let i = 0; i < MAX_NOTES + 5; i++) addNote('dash_1', `note ${i}`)
    expect(loadMemory('dash_1')).toHaveLength(MAX_NOTES)
  })

  it('trims blank notes away', () => {
    saveMemory('dash_1', ['  ', 'real note', ''])
    expect(loadMemory('dash_1')).toEqual(['real note'])
  })

  it('clears storage when the last note goes', () => {
    addNote('dash_1', 'only')
    removeNote('dash_1', 0)
    expect(loadMemory('dash_1')).toEqual([])
  })

  it('survives corrupt storage', () => {
    localStorage.setItem('linkr.agent.memory.dash_1', 'not json')
    expect(loadMemory('dash_1')).toEqual([])
  })

  it('renders a prompt block, or nothing when empty', () => {
    expect(memoryContext([])).toBe('')
    expect(memoryContext(['Use histograms', 'Label axes in French'])).toBe(
      'User preferences:\n- Use histograms\n- Label axes in French'
    )
  })
})
