import { describe, expect, it } from 'vitest'
import { compareEtlFilesByOrder } from './etl-file-order'

describe('compareEtlFilesByOrder', () => {
  const f = (name: string, order: number) => ({ name, order })

  it('sorts by order first', () => {
    const out = [f('b.sql', 1), f('a.sql', 0)].sort(compareEtlFilesByOrder)
    expect(out.map((x) => x.name)).toEqual(['a.sql', 'b.sql'])
  })

  it('breaks a tie on the name, so the run sequence is the same everywhere', () => {
    // Two files sharing order 5 — the real diff that surfaced this. Without the
    // tiebreak the sequence came from the storage's return order, which differs
    // between a client IDB and the server.
    const asIdbYieldsThem = [f('20_map_visit.sql', 5), f('14_src_note.sql', 5)]
    const asServerYieldsThem = [f('14_src_note.sql', 5), f('20_map_visit.sql', 5)]
    const expected = ['14_src_note.sql', '20_map_visit.sql']
    expect(asIdbYieldsThem.sort(compareEtlFilesByOrder).map((x) => x.name)).toEqual(expected)
    expect(asServerYieldsThem.sort(compareEtlFilesByOrder).map((x) => x.name)).toEqual(expected)
  })

  it('compares tied numeric prefixes naturally, not as strings', () => {
    // A plain string sort puts 10_ before 2_, which is the wrong run sequence.
    const out = [f('10_b.sql', 0), f('2_a.sql', 0)].sort(compareEtlFilesByOrder)
    expect(out.map((x) => x.name)).toEqual(['2_a.sql', '10_b.sql'])
  })

  it("keeps negative orders (generated scripts) ahead of the user's scripts", () => {
    const out = [f('10_src.sql', 0), f('00_vocabulary.sql', -1)].sort(compareEtlFilesByOrder)
    expect(out.map((x) => x.name)).toEqual(['00_vocabulary.sql', '10_src.sql'])
  })
})
