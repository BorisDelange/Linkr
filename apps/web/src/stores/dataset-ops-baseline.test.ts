/**
 * The baseline reconstruction behind undo.
 *
 * Inverses are built against the state their op saw, which means replaying the log
 * forward from the UNEDITED parsed rows. Neither mode hands those over directly:
 * front-only holds the already-replayed rows in memory, and server mode pages the
 * already-replayed cache. `unreplay` reconstructs the baseline by dropping the
 * rows the log added — the property tested here.
 */
import { describe, expect, it } from 'vitest'
import { ROW_ORD, replayOps, type DatasetOp, type ReplayInput } from '@linkr/format'
import { unreplay } from './dataset-ops-baseline'

let seq = 0
const mint = () => ({ id: `op${++seq}`, at: 1_700_000_000_000 })

function baseline(): ReplayInput {
  return {
    columns: [
      { id: 'col_a', name: 'a', type: 'string', order: 0 },
      { id: 'col_b', name: 'b', type: 'string', order: 1 },
    ],
    rows: [
      { col_a: '1', col_b: 'x' },
      { col_a: '2', col_b: 'y' },
    ],
  }
}

/** The baseline as replayOps normalises it — ordinals assigned, nothing else. */
const normalised = () => replayOps(baseline(), [])

describe('unreplay', () => {
  it('is the identity on an empty log, bar ordinal assignment', () => {
    expect(unreplay(baseline(), [])).toEqual(normalised())
  })

  it('recovers the baseline after cell edits', () => {
    const ops: DatasetOp[] = [
      { ...mint(), type: 'setCell', row: 0, column: 'col_a', value: 'edited' },
    ]
    const edited = replayOps(baseline(), ops)
    // Cell values are NOT restored — the baseline only has to carry row identity
    // and shape, since replaying the log forward re-applies every value.
    expect(unreplay(edited, ops).rows.map((r) => r[ROW_ORD])).toEqual([0, 1])
  })

  it('drops rows the log added, so replaying does not double them', () => {
    const ops: DatasetOp[] = [
      { ...mint(), type: 'addRow', row: -1, values: { col_a: 'new' } },
    ]
    const edited = replayOps(baseline(), ops)
    expect(edited.rows).toHaveLength(3)

    const recovered = unreplay(edited, ops)
    expect(recovered.rows).toHaveLength(2)
    expect(replayOps(recovered, ops).rows).toHaveLength(3)
  })

  it('round-trips a mixed log without drift', () => {
    const ops: DatasetOp[] = [
      { ...mint(), type: 'addRow', row: -1, values: { col_a: 'new' } },
      { ...mint(), type: 'setCell', row: 0, column: 'col_b', value: 'edited' },
      { ...mint(), type: 'addColumn', column: 'col_c', name: 'c', colType: 'number' },
      { ...mint(), type: 'setCell', row: -1, column: 'col_c', value: 42 },
    ]
    const edited = replayOps(baseline(), ops)
    const replayedAgain = replayOps(unreplay(edited, ops), ops)

    expect(replayedAgain.rows).toEqual(edited.rows)
    expect(replayedAgain.columns).toEqual(edited.columns)
  })

  it('stays stable when applied twice (an undo re-reads the baseline)', () => {
    const ops: DatasetOp[] = [
      { ...mint(), type: 'addRow', row: -1 },
      { ...mint(), type: 'setCell', row: 1, column: 'col_a', value: 'v' },
    ]
    const edited = replayOps(baseline(), ops)
    const once = unreplay(edited, ops)
    expect(unreplay(replayOps(once, ops), ops)).toEqual(once)
  })

  it('keeps a removed row out of the baseline it cannot resurrect', () => {
    // A removeRow's inverse carries the row's values itself, so the baseline does
    // not need it back — but the reconstruction must not invent it either.
    const ops: DatasetOp[] = [{ ...mint(), type: 'removeRow', row: 0 }]
    const edited = replayOps(baseline(), ops)
    expect(unreplay(edited, ops).rows.map((r) => r[ROW_ORD])).toEqual([1])
  })
})
