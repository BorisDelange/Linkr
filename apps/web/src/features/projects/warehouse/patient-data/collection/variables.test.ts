import { describe, expect, it } from 'vitest'
import type { PatientCollectionCategory, PatientCollectionVariable } from '@/types'
import { groupVariables } from './variables'

const v = (columnId: string, categoryId?: string): PatientCollectionVariable => ({
  columnId, origin: 'created', ...(categoryId ? { categoryId } : {}),
})
const cat = (id: string): PatientCollectionCategory => ({ id, name: { en: id } })

describe('groupVariables', () => {
  it('puts everything in one unnamed section when there are no categories', () => {
    const groups = groupVariables([v('a'), v('b')], undefined)
    expect(groups).toHaveLength(1)
    expect(groups[0].category).toBeUndefined()
    expect(groups[0].variables.map((x) => x.columnId)).toEqual(['a', 'b'])
  })

  it('renders the ungrouped variables FIRST, before any category', () => {
    // A form gaining its first category must not push what it already held below a
    // heading those variables were never filed under.
    const groups = groupVariables([v('a', 'c1'), v('loose')], [cat('c1')])
    expect(groups.map((g) => g.category?.id)).toEqual([undefined, 'c1'])
  })

  it('orders sections by the category list, not by the variables', () => {
    const groups = groupVariables([v('a', 'c2'), v('b', 'c1')], [cat('c1'), cat('c2')])
    expect(groups.map((g) => g.category?.id)).toEqual(['c1', 'c2'])
  })

  it('drops a category that holds nothing', () => {
    // A heading with no form under it is noise.
    const groups = groupVariables([v('a', 'c1')], [cat('c1'), cat('empty')])
    expect(groups.map((g) => g.category?.id)).toEqual(['c1'])
  })

  it('falls back to ungrouped when the named category is gone', () => {
    // The trap: deleting a category must not hide its variables behind a heading
    // that is no longer rendered.
    const groups = groupVariables([v('a', 'deleted')], [cat('c1')])
    expect(groups).toHaveLength(1)
    expect(groups[0].category).toBeUndefined()
    expect(groups[0].variables.map((x) => x.columnId)).toEqual(['a'])
  })

  it('keeps every variable exactly once across the sections', () => {
    const vars = [v('a'), v('b', 'c1'), v('c', 'c2'), v('d', 'gone')]
    const groups = groupVariables(vars, [cat('c1'), cat('c2')])
    const seen = groups.flatMap((g) => g.variables.map((x) => x.columnId))
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns nothing when there are no variables', () => {
    expect(groupVariables([], [cat('c1')])).toEqual([])
  })
})
