import { describe, expect, it } from 'vitest'
import { sortOutputRows } from './output-table-sort'

const col = (rows: string[][]) => rows.map((r) => r[0])

describe('sortOutputRows', () => {
  it('sorts a number column numerically', () => {
    expect(col(sortOutputRows([['9'], ['10'], ['2']], 0, 'number', false))).toEqual(['2', '9', '10'])
    expect(col(sortOutputRows([['9'], ['10'], ['2']], 0, 'number', true))).toEqual(['10', '9', '2'])
  })

  it('puts empty and null cells last in both directions', () => {
    const rows = [['b'], [''], ['a'], ['NULL'], ['c']]
    expect(col(sortOutputRows(rows, 0, 'string', false))).toEqual(['a', 'b', 'c', '', 'NULL'])
    expect(col(sortOutputRows(rows, 0, 'string', true))).toEqual(['c', 'b', 'a', '', 'NULL'])
  })

  it('compares text naturally and keeps ties in their original order', () => {
    expect(col(sortOutputRows([['item10'], ['item2'], ['Item2']], 0, 'string', false))).toEqual(['item2', 'Item2', 'item10'])
  })

  it('orders ISO dates chronologically', () => {
    expect(col(sortOutputRows([['2024-03-01'], ['2023-12-31']], 0, 'date', false))).toEqual(['2023-12-31', '2024-03-01'])
  })

  it('does not mutate its input', () => {
    const rows = [['2'], ['1']]
    sortOutputRows(rows, 0, 'number', false)
    expect(col(rows)).toEqual(['2', '1'])
  })
})
