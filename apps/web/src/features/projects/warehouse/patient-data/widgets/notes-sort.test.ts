import { describe, it, expect } from 'vitest'
import { sortNotes, noteAtOffset, NOTES_SORT_KEYS } from './notes-sort'

const notes = [
  { note_id: 1, note_date: '2024-03-01', note_title: 'Consultation' },
  { note_id: 2, note_date: '2024-01-15', note_title: 'Admission' },
  { note_id: 3, note_date: '2024-02-20', note_title: 'Zebra findings' },
]

const ids = (list: { note_id: number }[]) => list.map((n) => n.note_id)

describe('sortNotes', () => {
  it('keeps the query order when nothing is picked', () => {
    // The query already returns newest first; re-sorting would change the order
    // the widget has always opened on.
    const result = sortNotes(notes, null)
    expect(ids(result)).toEqual([1, 2, 3])
    expect(result).toBe(notes)
  })

  it('sorts oldest first by date ascending', () => {
    expect(ids(sortNotes(notes, { key: NOTES_SORT_KEYS.date, dir: 'asc' }))).toEqual([2, 3, 1])
  })

  it('sorts newest first by date descending', () => {
    expect(ids(sortNotes(notes, { key: NOTES_SORT_KEYS.date, dir: 'desc' }))).toEqual([1, 3, 2])
  })

  it('sorts A to Z by name', () => {
    expect(ids(sortNotes(notes, { key: NOTES_SORT_KEYS.name, dir: 'asc' }))).toEqual([2, 1, 3])
  })

  it('sorts Z to A by name', () => {
    expect(ids(sortNotes(notes, { key: NOTES_SORT_KEYS.name, dir: 'desc' }))).toEqual([3, 1, 2])
  })

  it('does not mutate the list it was given', () => {
    const original = [...notes]
    sortNotes(notes, { key: NOTES_SORT_KEYS.date, dir: 'asc' })
    expect(notes).toEqual(original)
  })

  it('survives an untitled note instead of throwing on localeCompare', () => {
    const withBlank = [...notes, { note_id: 4, note_date: '2024-04-01', note_title: '' }]
    expect(() => sortNotes(withBlank, { key: NOTES_SORT_KEYS.name, dir: 'asc' })).not.toThrow()
  })

  it('handles an unparseable date as the oldest rather than dropping it', () => {
    const withBad = [{ note_id: 9, note_date: 'not a date', note_title: 'X' }, ...notes]
    const result = sortNotes(withBad, { key: NOTES_SORT_KEYS.date, dir: 'asc' })
    expect(result[0].note_id).toBe(9)
  })
})

describe('noteAtOffset', () => {
  it('moves to the next note', () => {
    expect(noteAtOffset(notes, 1, 1)?.note_id).toBe(2)
  })

  it('moves to the previous note', () => {
    expect(noteAtOffset(notes, 2, -1)?.note_id).toBe(1)
  })

  it('stops at the end instead of wrapping to the start', () => {
    // Wrapping would jump from the newest note to the oldest with no cue.
    expect(noteAtOffset(notes, 3, 1)).toBeNull()
  })

  it('stops at the start instead of wrapping to the end', () => {
    expect(noteAtOffset(notes, 1, -1)).toBeNull()
  })

  it('enters at the first note when nothing is selected and moving down', () => {
    expect(noteAtOffset(notes, null, 1)?.note_id).toBe(1)
  })

  it('enters at the last note when nothing is selected and moving up', () => {
    expect(noteAtOffset(notes, null, -1)?.note_id).toBe(3)
  })

  it('enters the list when the selected note was filtered out', () => {
    // The selection survives a filter that hides it, so the id is real but absent.
    expect(noteAtOffset(notes, 99, 1)?.note_id).toBe(1)
  })

  it('has nowhere to go in an empty list', () => {
    expect(noteAtOffset([], 1, 1)).toBeNull()
  })
})
