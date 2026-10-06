import { describe, it, expect } from 'vitest'
import { aggregateByEntity } from './shared-styles'

const ROWS = [
  { pid: 1, los: 2, dead: false, svc: 'ICU' },
  { pid: 1, los: 4, dead: true, svc: 'HDU' },
  { pid: 2, los: 10, dead: false, svc: 'HDU' },
  { pid: null, los: 99, dead: true, svc: 'ICU' },
]

describe('aggregateByEntity', () => {
  it('keeps the first or last row of each entity, dropping rows with no entity', () => {
    expect(aggregateByEntity(ROWS, 'pid', 'first').map((r) => r.svc)).toEqual(['ICU', 'HDU'])
    expect(aggregateByEntity(ROWS, 'pid', 'last').map((r) => r.svc)).toEqual(['HDU', 'HDU'])
  })

  it('aggregates every number-like column by default, booleans included', () => {
    const [first] = aggregateByEntity(ROWS, 'pid', 'max')
    expect(first).toMatchObject({ pid: 1, los: 4, dead: 1, svc: 'ICU' })
  })

  it('aggregates only the listed columns when given, the rest taking the first row', () => {
    const [first] = aggregateByEntity(ROWS, 'pid', 'max', new Set(['los']))
    expect(first).toMatchObject({ pid: 1, los: 4, dead: false, svc: 'ICU' })
  })
})
