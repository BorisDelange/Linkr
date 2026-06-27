import { describe, it, expect } from 'vitest'
import { classifyDisposition } from './targeted-reseed'

// classifyDisposition is the safety gate for deleting "removed from seed" entities. Getting it
// wrong is destructive: classifying user content as 'seed' would let the app delete data the user
// created. The rule is strict — ONLY an explicit origin === 'seed' is deletable.
describe('classifyDisposition', () => {
  it("treats a missing local row as 'gone' (nothing to delete, just clear the notification)", () => {
    expect(classifyDisposition(undefined)).toBe('gone')
    expect(classifyDisposition(null)).toBe('gone')
  })

  it("treats an explicit seed-origin row as 'seed' (safe to delete)", () => {
    expect(classifyDisposition({ origin: 'seed' })).toBe('seed')
  })

  it("treats user-created content as 'user' (never touched)", () => {
    expect(classifyDisposition({ origin: 'user' })).toBe('user')
  })

  it("treats a row with no origin (pre-origin-field data) as 'user', not 'seed'", () => {
    // The most important case: legacy rows predate the origin field. They must NOT be deletable,
    // even though they may well have come from the seed — we never delete without explicit proof.
    expect(classifyDisposition({})).toBe('user')
  })

  it("treats an unexpected origin value as 'user' (fail safe)", () => {
    expect(classifyDisposition({ origin: 'something-else' })).toBe('user')
  })
})
