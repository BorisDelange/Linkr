/**
 * The baseline reconstruction behind undo.
 *
 * Undo drops the last action from the log and replays what remains, so it needs the
 * UNEDITED parsed rows to replay over. Neither mode hands those over directly:
 * front-only holds the already-replayed rows in memory, and server mode pages the
 * already-replayed cache. `unreplay` reconstructs the baseline by rewinding what
 * the log did — the property tested here.
 *
 * The end-to-end suite at the bottom is the one that matters: it runs the store's
 * actual undo sequence, which is where an earlier design — appending each op's
 * inverse — produced an inverse that changed nothing.
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

/**
 * Undo end-to-end, mirroring `undoLastOps`: DROP the last group from the log and
 * replay what remains over the baseline.
 *
 * There is no inverse to compute. The dataset is `raw -> parse -> replay(ops)` and
 * the raw is immutable, so a shorter log simply *is* the earlier state — which is
 * also why no value can be unrecoverable, however the log was written.
 */
function undoLast(raw: ReplayInput, log: DatasetOp[]): ReplayInput {
  // Mirrors the store: the baseline is captured on the FIRST edit, when the log is
  // still empty, so the rewind is exact. Deriving it later — from rows the log has
  // already changed — is what loses a raw cell's original value.
  const base = unreplay(raw, [])
  const groupId = log[log.length - 1]?.group
  const start = groupId ? log.findIndex((op) => op.group === groupId) : log.length - 1
  return replayOps(base, log.slice(0, start))
}

describe('undo', () => {
  const cols = [{ id: 'col_a', name: 'a', type: 'string' as const, order: 0 }]
  const oneRow = (): ReplayInput => ({ columns: cols, rows: [{ [ROW_ORD]: 0, col_a: 'old' }] })

  it('restores a raw cell overwritten once', () => {
    const log: DatasetOp[] = [
      { ...mint(), group: 'g1', type: 'setCell', row: 0, column: 'col_a', value: 'new' },
    ]
    expect(undoLast(oneRow(), log).rows[0].col_a).toBe('old')
  })

  it('restores the previous value when a cell was edited twice', () => {
    const log: DatasetOp[] = [
      { ...mint(), group: 'g1', type: 'setCell', row: 0, column: 'col_a', value: 'first' },
      { ...mint(), group: 'g2', type: 'setCell', row: 0, column: 'col_a', value: 'second' },
    ]
    expect(undoLast(oneRow(), log).rows[0].col_a).toBe('first')
  })

  it('restores a cell that was empty before the edit', () => {
    const raw: ReplayInput = { columns: cols, rows: [{ [ROW_ORD]: 0, col_a: null }] }
    const log: DatasetOp[] = [
      { ...mint(), group: 'g1', type: 'setCell', row: 0, column: 'col_a', value: 'typed' },
    ]
    expect(undoLast(raw, log).rows[0].col_a).toBeNull()
  })

  it('removes a row the log added', () => {
    const log: DatasetOp[] = [
      { ...mint(), group: 'g1', type: 'addRow', row: -1, values: { col_a: 'added' } },
    ]
    expect(undoLast(oneRow(), log).rows).toHaveLength(1)
  })

  it('removes a column the log added', () => {
    const log: DatasetOp[] = [
      { ...mint(), group: 'g1', type: 'addColumn', column: 'col_b', name: 'b', colType: 'string' },
    ]
    expect(undoLast(oneRow(), log).columns.map((c) => c.id)).toEqual(['col_a'])
  })

  it('restores a removed column with its data', () => {
    // Truncation restores this for free, where computing an inverse could not: the
    // cells are back because they were never absent from the raw.
    const log: DatasetOp[] = [{ ...mint(), group: 'g1', type: 'removeColumn', column: 'col_a' }]
    const after = undoLast(oneRow(), log)
    expect(after.columns.map((c) => c.id)).toEqual(['col_a'])
    expect(after.rows[0].col_a).toBe('old')
  })

  it('reverses a whole group, not just its last op', () => {
    // One user action can record several ops; dropping a fragment would leave the
    // dataset half-changed.
    const log: DatasetOp[] = [
      { ...mint(), group: 'g1', type: 'addColumn', column: 'col_b', name: 'b', colType: 'string' },
      { ...mint(), group: 'g1', type: 'setCell', row: 0, column: 'col_b', value: 'x' },
    ]
    expect(undoLast(oneRow(), log).columns.map((c) => c.id)).toEqual(['col_a'])
  })

  it('leaves nothing behind once every action is undone', () => {
    // The point of truncating: undo shortens the log instead of appending to it,
    // so repeated undos terminate at the raw file rather than growing forever.
    let log: DatasetOp[] = [
      { ...mint(), group: 'g1', type: 'setCell', row: 0, column: 'col_a', value: 'x' },
      { ...mint(), group: 'g2', type: 'setCell', row: 0, column: 'col_a', value: 'y' },
    ]
    for (let i = 0; i < 2; i++) {
      const groupId = log[log.length - 1].group
      const start = log.findIndex((op) => op.group === groupId)
      log = log.slice(0, start)
    }
    expect(log).toEqual([])
    expect(replayOps(oneRow(), log).rows[0].col_a).toBe('old')
  })
})

describe('a baseline derived late', () => {
  const cols = [{ id: 'col_a', name: 'a', type: 'string' as const, order: 0 }]

  it('keeps the edited value rather than blanking it', () => {
    // Front-only, reopening a file that already carries a log: the baseline was not
    // captured before the first edit, so the raw value is genuinely gone. `unreplay`
    // must then leave the cell as it stands — blanking it would destroy real data to
    // satisfy a reconstruction, and replaying the log re-applies the value anyway.
    const raw: ReplayInput = { columns: cols, rows: [{ [ROW_ORD]: 0, col_a: 'raw' }] }
    const log: DatasetOp[] = [
      { ...mint(), group: 'g1', type: 'setCell', row: 0, column: 'col_a', value: 'edited' },
    ]
    const replayed = replayOps(raw, log)
    const late = unreplay({ columns: replayed.columns, rows: replayed.rows }, log)
    expect(late.rows[0].col_a).toBe('edited')
    // Replaying the full log over it still shows what the user last saw.
    expect(replayOps(late, log).rows[0].col_a).toBe('edited')
  })
})
