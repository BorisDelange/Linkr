import { describe, expect, it } from 'vitest'
import type { DqCustomCheck } from '@/types'
import { checkKeys, importedChecks, portableChecks } from './dq-check-portable'

const check = (id: string, name: string, order: number, templateKey: string | null = null) =>
  ({ id, ruleSetId: 'rs', name, order, templateKey, updatedAt: 'x', createdAt: 'c' }) as unknown as DqCustomCheck

describe('dq-check-portable', () => {
  it('writes checks in display order without their local fields', () => {
    expect(portableChecks([check('b', 'Two', 1), check('a', 'One', 0)])).toEqual([
      { name: 'One', order: 0, templateKey: null, createdAt: 'c' },
      { name: 'Two', order: 1, templateKey: null, createdAt: 'c' },
    ])
  })

  it('keys a check by its template key, else its name, disambiguating duplicates', () => {
    expect(checkKeys([
      { name: 'Not null', templateKey: 'ddl.not_null:person.id' },
      { name: 'Same name', templateKey: null },
      { name: 'Same name', templateKey: null },
    ] as DqCustomCheck[])).toEqual(['ddl.not_null:person.id', 'same-name', 'same-name#2'])
  })

  it('lands the same check on the same id every time, and on another id in another rule set', () => {
    const exported = portableChecks([check('a', 'One', 3), check('b', 'Two', 3)])
    const first = importedChecks(exported, 'rs-1')
    expect(importedChecks(portableChecks(first), 'rs-1').map((c) => c.id)).toEqual(first.map((c) => c.id))
    expect(first.map((c) => c.order)).toEqual([0, 1])
    expect(importedChecks(exported, 'rs-2')[0].id).not.toBe(first[0].id)
  })
})
