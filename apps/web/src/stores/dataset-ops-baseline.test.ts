/**
 * The baseline reconstruction behind undo.
 *
 * Inverses are built against the state their op saw, which means replaying the log
 * forward from the UNEDITED parsed rows. Neither mode hands those over directly:
 * front-only holds the already-replayed rows in memory, and server mode pages the
 * already-replayed cache. `unreplay` reconstructs the baseline by rewinding what
 * the log did — the property tested here.
 *
 * The end-to-end suite at the bottom is the one that matters: it runs the store's
 * actual undo sequence, which is where a baseline that looks plausible in
 * isolation still produced an inverse that changed nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  cellKeyOfRow, invertOpFull, ROW_ORD, replayOps, type DatasetOp, type ReplayInput,
} from '@linkr/format'
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

/**
 * Undo end-to-end, mirroring `undoLastOps`: reconstruct the baseline from the
 * replayed state, invert the last op against it, and replay the whole log plus the
 * inverse. What the user should see is the dataset as it was before that op.
 */
function undoLast(raw: ReplayInput, log: DatasetOp[]): ReplayInput {
  const replayed = replayOps(raw, log)
  const base = unreplay({ columns: replayed.columns, rows: replayed.rows }, log)
  const last = log.length - 1
  const before = replayOps(base, log.slice(0, last))
  const inverses = invertOpFull(log[last], before, mint)
  return replayOps(base, [...log, ...inverses])
}

describe('undo', () => {
  const cols = [{ id: 'col_a', name: 'a', type: 'string' as const, order: 0 }]
  const oneRow = (): ReplayInput => ({ columns: cols, rows: [{ [ROW_ORD]: 0, col_a: 'old' }] })

  it('restores a raw cell overwritten once', () => {
    // The regression: without `prev` the baseline still held 'new', so the inverse
    // was `setCell 'new'` and undo appeared to do nothing at all.
    const log: DatasetOp[] = [
      { ...mint(), type: 'setCell', row: 0, column: 'col_a', value: 'new', prev: 'old' },
    ]
    expect(undoLast(oneRow(), log).rows[0].col_a).toBe('old')
  })

  it('restores the previous value when a cell was edited twice', () => {
    const log: DatasetOp[] = [
      { ...mint(), type: 'setCell', row: 0, column: 'col_a', value: 'first', prev: 'old' },
      { ...mint(), type: 'setCell', row: 0, column: 'col_a', value: 'second', prev: 'first' },
    ]
    expect(undoLast(oneRow(), log).rows[0].col_a).toBe('first')
  })

  it('restores a cell that was empty before the edit', () => {
    // `prev: null` must survive canonicalisation — dropped as "absent", undo would
    // fall back to the replayed value and keep the edit.
    const raw: ReplayInput = { columns: cols, rows: [{ [ROW_ORD]: 0, col_a: null }] }
    const log: DatasetOp[] = [
      { ...mint(), type: 'setCell', row: 0, column: 'col_a', value: 'typed', prev: null },
    ]
    expect(undoLast(raw, log).rows[0].col_a).toBeNull()
  })

  it('undoes a log written before `prev` existed, as far as it can', () => {
    const log: DatasetOp[] = [
      { ...mint(), type: 'setCell', row: 0, column: 'col_a', value: 'first' },
      { ...mint(), type: 'setCell', row: 0, column: 'col_a', value: 'second' },
    ]
    expect(undoLast(oneRow(), log).rows[0].col_a).toBe('first')
  })

  it('removes a row the log added', () => {
    const log: DatasetOp[] = [
      { ...mint(), type: 'addRow', row: -1, values: { col_a: 'added' } },
    ]
    expect(undoLast(oneRow(), log).rows).toHaveLength(1)
  })

  it('removes a column the log added', () => {
    const log: DatasetOp[] = [
      { ...mint(), type: 'addColumn', column: 'col_b', name: 'b', colType: 'string' },
    ]
    expect(undoLast(oneRow(), log).columns.map((c) => c.id)).toEqual(['col_a'])
  })

  it('restores a removed column with its data, from the snapshot the op carries', () => {
    // Replay deletes the column and its cells outright, so the snapshot is the
    // only copy left; without it undo re-adds an empty column.
    const log: DatasetOp[] = [{
      ...mint(), type: 'removeColumn', column: 'col_a',
      prev: { name: 'a', colType: 'string', index: 0, cells: { [cellKeyOfRow(0)]: 'old' } },
    }]
    const after = undoLast(oneRow(), log)
    expect(after.columns.map((c) => c.id)).toEqual(['col_a'])
    expect(after.rows[0].col_a).toBe('old')
  })

  it('cannot undo a column removal recorded before the snapshot field', () => {
    // Documenting a real limit, not endorsing it: replay deletes the column and
    // every cell, and a pre-`prev` op kept no copy — so neither the shape nor the
    // data is anywhere to be found and undo is a no-op. Only logs written by this
    // version onwards are reversible here; nothing can retrofit the old ones.
    const log: DatasetOp[] = [{ ...mint(), type: 'removeColumn', column: 'col_a' }]
    expect(undoLast(oneRow(), log).columns).toEqual([])
  })
})
