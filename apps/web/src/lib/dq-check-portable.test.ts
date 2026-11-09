import { describe, expect, it } from 'vitest'
import type { DqCustomCheck } from '@/types'
import { checkKeys, importedChecks, portableChecks, withCheckKeys } from './dq-check-portable'

const check = (id: string, name: string, order: number, templateKey: string | null = null) =>
  ({ id, ruleSetId: 'rs', name, order, templateKey, updatedAt: 'x', createdAt: 'c' }) as unknown as DqCustomCheck

describe('dq-check-portable', () => {
  it('writes checks in display order, key first, without their local fields', () => {
    const out = portableChecks([check('b', 'Two', 1), check('a', 'One', 0)])
    expect(out).toEqual([
      { checkKey: 'one', name: 'One', order: 0, templateKey: null, createdAt: 'c' },
      { checkKey: 'two', name: 'Two', order: 1, templateKey: null, createdAt: 'c' },
    ])
    expect(Object.keys(out[0])[0]).toBe('checkKey')
  })

  it('keeps a stored key when the check is renamed, through export and import', () => {
    const renamed = { ...check('a', 'Renamed', 0), checkKey: 'original-name' }
    const [imported] = importedChecks(portableChecks([renamed]), 'rs')
    expect(imported.checkKey).toBe('original-name')
    expect(imported.id).toBe(importedChecks(portableChecks([{ ...renamed, name: 'Again' }]), 'rs')[0].id)
  })

  it('keys new checks apart from the ones their rule set holds', () => {
    const existing = [{ name: 'Same', templateKey: null, checkKey: 'same' }]
    expect(withCheckKeys([{ name: 'Same', templateKey: null }], existing)[0].checkKey).toBe('same#2')
    expect(withCheckKeys([{ name: 'Other', templateKey: null, checkKey: 'kept' }], existing)[0].checkKey).toBe('kept')
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
