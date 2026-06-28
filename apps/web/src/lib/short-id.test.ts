import { describe, it, expect } from 'vitest'
import { shortenId, shortenIdAmong, resolveByIdPrefix } from './short-id'

// URLs carry an 8-char prefix; resolution maps it back to one entity. A wrong resolver either
// opens the wrong entity (prefix collision treated as a match) or breaks existing full-id links.
describe('shortenId', () => {
  it('truncates a UUID to its first 8 hex chars', () => {
    expect(shortenId('7b4450e6-6b7b-44d4-b8e5-6efdcac7dadc')).toBe('7b4450e6')
  })

  it('leaves a human-readable slug untouched (no dashes-to-uuid assumption)', () => {
    expect(shortenId('icu')).toBe('icu')
    expect(shortenId('short')).toBe('short')
  })

  it('leaves a long slug without UUID dashes untouched', () => {
    expect(shortenId('icuactivitydashboard')).toBe('icuactivitydashboard')
  })

  it('passes through an id shorter than the prefix length', () => {
    expect(shortenId('abc')).toBe('abc')
  })
})

// shortenIdAmong grows the prefix only as far as needed to stay unique among siblings — the
// emit-side guarantee that a shortened URL round-trips via resolveByIdPrefix. The seed's
// sequential 00000000-… uuids are the case that motivated it.
describe('shortenIdAmong', () => {
  it('uses the 8-char prefix when it is already unique', () => {
    const a = '7b4450e6-6b7b-44d4-b8e5-6efdcac7dadc'
    const b = '9b35c85a-fb20-46fe-996c-6d84dec036ad'
    expect(shortenIdAmong(a, [a, b])).toBe('7b4450e6')
  })

  it('grows the prefix to disambiguate the seed sequential uuids', () => {
    // Two demo projects whose first 28 chars are identical — 8 chars would collide.
    const p1 = '00000000-0000-0000-0000-000000000001'
    const p5 = '00000000-0000-0000-0000-000000000005'
    const s1 = shortenIdAmong(p1, [p1, p5])
    const s5 = shortenIdAmong(p5, [p1, p5])
    expect(s1).not.toBe(s5)               // distinct prefixes
    expect(p1.startsWith(s1)).toBe(true)  // each is a real prefix of its id
    expect(p5.startsWith(s5)).toBe(true)
    // And they round-trip: each short prefix resolves back to its own id, unambiguously.
    expect(resolveByIdPrefix([{ id: p1 }, { id: p5 }], s1, (x) => x.id)?.id).toBe(p1)
    expect(resolveByIdPrefix([{ id: p1 }, { id: p5 }], s5, (x) => x.id)?.id).toBe(p5)
  })

  it('ignores the id itself among siblings', () => {
    const a = '7b4450e6-6b7b-44d4-b8e5-6efdcac7dadc'
    expect(shortenIdAmong(a, [a])).toBe('7b4450e6')
  })

  it('passes a human-readable slug through unchanged (dashes, but not a UUID)', () => {
    expect(shortenIdAmong('icu-activity-dashboard', ['icu-activity-dashboard', 'other'])).toBe('icu-activity-dashboard')
  })
})

describe('resolveByIdPrefix', () => {
  const items = [
    { uid: '7b4450e6-6b7b-44d4-b8e5-6efdcac7dadc' },
    { uid: '9b35c85a-fb20-46fe-996c-6d84dec036ad' },
    { uid: '7b44ffff-0000-0000-0000-000000000000' }, // shares '7b44' with the first
  ]
  const getId = (x: { uid: string }) => x.uid

  it('resolves a unique short prefix to its entity', () => {
    expect(resolveByIdPrefix(items, '7b4450e6', getId)).toBe(items[0])
  })

  it('still resolves a full id (existing links keep working)', () => {
    expect(resolveByIdPrefix(items, '9b35c85a-fb20-46fe-996c-6d84dec036ad', getId)).toBe(items[1])
  })

  it('returns undefined for an ambiguous prefix (treated as not found)', () => {
    // '7b44' matches both items[0] and items[2].
    expect(resolveByIdPrefix(items, '7b44', getId)).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(resolveByIdPrefix(items, 'deadbeef', getId)).toBeUndefined()
  })

  it('returns undefined for an empty/absent param', () => {
    expect(resolveByIdPrefix(items, undefined, getId)).toBeUndefined()
    expect(resolveByIdPrefix(items, '', getId)).toBeUndefined()
  })

  it('prefers an exact full-id match even if it is a prefix of another id', () => {
    // An id that is itself a prefix of a longer sibling must still resolve to itself exactly.
    const withExact = [{ uid: '7b44' }, { uid: '7b4450e6-0000' }]
    expect(resolveByIdPrefix(withExact, '7b44', (x) => x.uid)).toBe(withExact[0])
  })
})
