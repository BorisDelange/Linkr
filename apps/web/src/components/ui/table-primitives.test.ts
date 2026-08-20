import { describe, it, expect } from 'vitest'
import type { ColumnDef } from '@tanstack/react-table'
import { nextSorting, columnLabel, type TableSorting } from './table-primitives'

describe('nextSorting', () => {
  it('starts a fresh column descending', () => {
    expect(nextSorting(null, 'record_count')).toEqual({ columnId: 'record_count', desc: true })
  })

  it('switches to ascending on the second click', () => {
    expect(nextSorting({ columnId: 'name', desc: true }, 'name')).toEqual({ columnId: 'name', desc: false })
  })

  it('clears the sort on the third click', () => {
    expect(nextSorting({ columnId: 'name', desc: false }, 'name')).toBeNull()
  })

  it('restarts descending when moving to another column', () => {
    // Not "inherit the previous direction": the point of the first click on a
    // new column is to see its biggest values.
    expect(nextSorting({ columnId: 'name', desc: false }, 'record_count'))
      .toEqual({ columnId: 'record_count', desc: true })
  })

  it('cycles back to descending after clearing', () => {
    let s: TableSorting = null
    s = nextSorting(s, 'x')
    s = nextSorting(s, 'x')
    s = nextSorting(s, 'x')
    expect(s).toBeNull()
    expect(nextSorting(s, 'x')).toEqual({ columnId: 'x', desc: true })
  })
})

describe('columnLabel', () => {
  const cols = [
    { id: 'plain', header: 'Concept name' },
    { id: 'fn', header: () => 'Vocabulary' },
    { id: 'node', header: () => null },
  ] as unknown as ColumnDef<unknown>[]

  it('returns a string header as-is', () => {
    expect(columnLabel(cols, 'plain')).toBe('Concept name')
  })

  it('calls a function header to recover its text', () => {
    expect(columnLabel(cols, 'fn')).toBe('Vocabulary')
  })

  it('falls back to a de-slugified id when the header renders a node', () => {
    expect(columnLabel(cols, 'node')).toBe('Node')
  })

  it('falls back to a de-slugified id for an unknown column', () => {
    expect(columnLabel(cols, 'concept_class_id')).toBe('Concept Class Id')
  })

  it('title-cases every word of a snake_case id', () => {
    expect(columnLabel([], 'source_concept_code')).toBe('Source Concept Code')
  })
})
