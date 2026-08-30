import type { SortState } from '@/components/ui/list-page-toolbar'

/** Sort keys the notes list offers. */
export const NOTES_SORT_KEYS = {
  date: 'date',
  name: 'name',
} as const

/** What sorting needs from a note; the widget's row type is wider. */
export interface SortableNote {
  note_date: string
  note_title: string
}

function time(value: string | null | undefined): number {
  if (!value) return 0
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

/**
 * Order the notes list.
 *
 * The query already returns newest first, so the default (`null`) keeps that
 * order rather than re-sorting — it is what the widget has always shown, and it
 * is the order a clinician expects to land on.
 *
 * `asc` means what it says on each field: oldest first by date, A→Z by name.
 */
export function sortNotes<T extends SortableNote>(notes: T[], sort: SortState | null): T[] {
  if (!sort) return notes
  const mult = sort.dir === 'asc' ? 1 : -1

  if (sort.key === NOTES_SORT_KEYS.name) {
    // Coerce to '': an untitled note would throw on localeCompare and break the
    // whole list.
    return [...notes].sort((a, b) => mult * (a.note_title ?? '').localeCompare(b.note_title ?? ''))
  }
  if (sort.key === NOTES_SORT_KEYS.date) {
    return [...notes].sort((a, b) => mult * (time(a.note_date) - time(b.note_date)))
  }
  return notes
}

/**
 * The note to select when an arrow key moves off `currentId`.
 *
 * Returns null when there is nowhere to go — an empty list, or already at the
 * end — so the caller can leave the selection alone rather than wrapping around,
 * which would silently jump from the newest note to the oldest.
 */
export function noteAtOffset<T extends { note_id: number }>(
  notes: T[],
  currentId: number | null,
  offset: number,
): T | null {
  if (notes.length === 0) return null
  const index = notes.findIndex((n) => n.note_id === currentId)
  // Nothing selected yet: an arrow key enters the list at whichever end the key
  // points from — down takes the first note, up the last.
  if (index === -1) return offset > 0 ? notes[0] : notes[notes.length - 1]
  const next = index + offset
  if (next < 0 || next >= notes.length) return null
  return notes[next]
}
