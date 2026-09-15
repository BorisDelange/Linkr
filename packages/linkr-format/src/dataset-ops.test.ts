import { describe, expect, it } from 'vitest'
import {
  canonicalOp,
  compactOps,
  invertOp,
  invertOpFull,
  opsHash,
  replayOps,
  retypeAddedColumn,
  ROW_ORD,
  type DatasetCellValue,
  type DatasetOp,
  type OpColumn,
  type ReplayInput,
} from './dataset-ops.js'

let seq = 0
const mint = () => ({ id: `op${++seq}`, at: 1_700_000_000_000 })

/** `Omit` distributes badly over the op union (it collapses to the common fields),
 *  so spell the omission out per member to keep each variant's own fields. */
type OpBody<T extends DatasetOp = DatasetOp> = T extends T ? Omit<T, 'id' | 'at'> : never

const op = <T extends DatasetOp = DatasetOp>(body: OpBody<T>): T =>
  ({ ...mint(), ...body }) as unknown as T

function cols(...names: string[]): OpColumn[] {
  return names.map((name, i) => ({ id: `col_${name}`, name, type: 'string', order: i }))
}

function base(): ReplayInput {
  return {
    columns: cols('a', 'b'),
    rows: [
      { col_a: '1', col_b: 'x' },
      { col_a: '2', col_b: 'y' },
      { col_a: '3', col_b: 'z' },
    ],
  }
}

describe('replayOps', () => {
  it('assigns raw ordinals from row position', () => {
    const out = replayOps(base(), [])
    expect(out.rows.map((r) => r[ROW_ORD])).toEqual([0, 1, 2])
  })

  it('leaves the input untouched', () => {
    const input = base()
    replayOps(input, [op({ type: 'removeRow', row: 0 })])
    expect(input.rows).toHaveLength(3)
    expect(input.rows[0][ROW_ORD]).toBeUndefined()
  })

  it('sets a cell by row ordinal, not position', () => {
    const out = replayOps(base(), [
      op({ type: 'removeRow', row: 0 }),
      op({ type: 'setCell', row: 2, column: 'col_b', value: 'edited' }),
    ])
    expect(out.rows.map((r) => r[ROW_ORD])).toEqual([1, 2])
    expect(out.rows[1].col_b).toBe('edited')
  })

  it('skips a setCell on a removed row or unknown column', () => {
    const out = replayOps(base(), [
      op({ type: 'removeRow', row: 1 }),
      op({ type: 'setCell', row: 1, column: 'col_a', value: 'gone' }),
      op({ type: 'setCell', row: 0, column: 'col_nope', value: 'gone' }),
    ])
    expect(out.rows).toHaveLength(2)
    expect(out.rows[0]).not.toHaveProperty('col_nope')
  })

  it('appends an added row with null-filled columns', () => {
    const out = replayOps(base(), [op({ type: 'addRow', row: -1 })])
    expect(out.rows).toHaveLength(4)
    expect(out.rows[3]).toEqual({ [ROW_ORD]: -1, col_a: null, col_b: null })
  })

  it('inserts an added row after a named ordinal', () => {
    const out = replayOps(base(), [
      op({ type: 'addRow', row: -1, after: 0, values: { col_a: 'new' } }),
    ])
    expect(out.rows.map((r) => r[ROW_ORD])).toEqual([0, -1, 1, 2])
    expect(out.rows[1].col_a).toBe('new')
    expect(out.rows[1].col_b).toBeNull()
  })

  it('ignores an addRow whose ordinal already exists', () => {
    const out = replayOps(base(), [op({ type: 'addRow', row: 1 })])
    expect(out.rows).toHaveLength(3)
  })

  it('reorders rows into the named sequence', () => {
    const out = replayOps(base(), [op({ type: 'reorderRows', order: [2, 0] })])
    expect(out.rows.map((r) => r[ROW_ORD])).toEqual([2, 1, 0])
  })

  it('adds a column at an index and renumbers order', () => {
    const out = replayOps(base(), [
      op({ type: 'addColumn', column: 'col_c', name: 'c', colType: 'number', index: 1 }),
    ])
    expect(out.columns.map((c) => c.id)).toEqual(['col_a', 'col_c', 'col_b'])
    expect(out.columns.map((c) => c.order)).toEqual([0, 1, 2])
    expect(out.rows[0].col_c).toBeNull()
  })

  it('removes a column from every row', () => {
    const out = replayOps(base(), [op({ type: 'removeColumn', column: 'col_a' })])
    expect(out.columns.map((c) => c.id)).toEqual(['col_b'])
    expect(out.rows[0]).not.toHaveProperty('col_a')
  })

  it('renames a column, moving its data to the new key', () => {
    const out = replayOps(base(), [
      op({ type: 'renameColumn', column: 'col_a', to: 'col_z', toName: 'z' }),
    ])
    expect(out.columns[0]).toMatchObject({ id: 'col_z', name: 'z' })
    expect(out.rows[0].col_z).toBe('1')
    expect(out.rows[0]).not.toHaveProperty('col_a')
  })

  it('refuses a rename onto an existing column id', () => {
    const out = replayOps(base(), [
      op({ type: 'renameColumn', column: 'col_a', to: 'col_b', toName: 'b' }),
    ])
    expect(out.columns.map((c) => c.id)).toEqual(['col_a', 'col_b'])
    expect(out.rows[0].col_b).toBe('x')
  })

  it('skips an unknown op type rather than throwing', () => {
    const out = replayOps(base(), [{ id: 'x', at: 0, type: 'nope' } as unknown as DatasetOp])
    expect(out.rows).toHaveLength(3)
  })

  it('keeps added rows disjoint from raw ordinals across replays', () => {
    const once = replayOps(base(), [op({ type: 'addRow', row: -1 })])
    const twice = replayOps(once, [op({ type: 'addRow', row: -2 })])
    expect(twice.rows.map((r) => r[ROW_ORD])).toEqual([0, 1, 2, -1, -2])
  })
})

describe('invertOp', () => {
  it('restores the overwritten value of a setCell', () => {
    const state = replayOps(base(), [])
    const edit = op<DatasetOp>({ type: 'setCell', row: 0, column: 'col_a', value: 'new' })
    const undo = invertOp(edit, state, mint())
    const after = replayOps(state, [edit, undo!])
    expect(after.rows[0].col_a).toBe('1')
  })

  it('undoes an addRow with a removeRow', () => {
    const state = replayOps(base(), [])
    const add = op<DatasetOp>({ type: 'addRow', row: -1 })
    const undo = invertOp(add, state, mint())
    expect(replayOps(state, [add, undo!]).rows).toHaveLength(3)
  })

  it('undoes a removeRow by restoring its values and position', () => {
    const state = replayOps(base(), [])
    const remove = op<DatasetOp>({ type: 'removeRow', row: 1 })
    const undo = invertOp(remove, state, mint())
    const after = replayOps(state, [remove, undo!])
    expect(after.rows.map((r) => r[ROW_ORD])).toEqual([0, 1, 2])
    expect(after.rows[1]).toMatchObject({ col_a: '2', col_b: 'y' })
  })

  it('undoes a reorder by restoring the previous order', () => {
    const state = replayOps(base(), [])
    const reorder = op<DatasetOp>({ type: 'reorderRows', order: [2, 0] })
    const undo = invertOp(reorder, state, mint())
    const after = replayOps(state, [reorder, undo!])
    expect(after.rows.map((r) => r[ROW_ORD])).toEqual([0, 1, 2])
  })

  it('undoes a rename by renaming back', () => {
    const state = replayOps(base(), [])
    const rename = op<DatasetOp>({ type: 'renameColumn', column: 'col_a', to: 'col_z', toName: 'z' })
    const undo = invertOp(rename, state, mint())
    const after = replayOps(state, [rename, undo!])
    expect(after.columns[0]).toMatchObject({ id: 'col_a', name: 'a' })
    expect(after.rows[0].col_a).toBe('1')
  })

  it('returns null when the op had no effect', () => {
    const state = replayOps(base(), [])
    expect(invertOp(op({ type: 'setCell', row: 99, column: 'col_a', value: 'x' }), state, mint())).toBeNull()
    expect(invertOp(op({ type: 'removeColumn', column: 'col_nope' }), state, mint())).toBeNull()
  })
})

describe('invertOpFull', () => {
  it('restores a removed column with its data', () => {
    const state = replayOps(base(), [])
    const remove = op<DatasetOp>({ type: 'removeColumn', column: 'col_a' })
    const undo = invertOpFull(remove, state, mint)
    const after = replayOps(state, [remove, ...undo])

    expect(after.columns.map((c) => c.id)).toEqual(['col_a', 'col_b'])
    expect(after.rows.map((r) => r.col_a)).toEqual(['1', '2', '3'])
  })

  it('does not emit a setCell for a null cell', () => {
    const state = replayOps({ columns: cols('a'), rows: [{ col_a: null }] }, [])
    const undo = invertOpFull(op({ type: 'removeColumn', column: 'col_a' }), state, mint)
    expect(undo).toHaveLength(1)
  })
})

describe('compactOps', () => {
  it('keeps only the last write to a cell', () => {
    const ops: DatasetOp[] = [
      op({ type: 'setCell', row: 0, column: 'col_a', value: 'first' }),
      op({ type: 'setCell', row: 0, column: 'col_a', value: 'second' }),
      op({ type: 'setCell', row: 0, column: 'col_a', value: 'third' }),
    ]
    const out = compactOps(ops)
    expect(out).toHaveLength(1)
    expect(replayOps(base(), out).rows[0].col_a).toBe('third')
  })

  it('does not merge writes to different cells', () => {
    const ops: DatasetOp[] = [
      op({ type: 'setCell', row: 0, column: 'col_a', value: 'p' }),
      op({ type: 'setCell', row: 1, column: 'col_a', value: 'q' }),
      op({ type: 'setCell', row: 0, column: 'col_b', value: 'r' }),
    ]
    expect(compactOps(ops)).toHaveLength(3)
  })

  it('drops edits to a row that is later removed', () => {
    const ops: DatasetOp[] = [
      op({ type: 'setCell', row: 1, column: 'col_a', value: 'doomed' }),
      op({ type: 'removeRow', row: 1 }),
    ]
    const out = compactOps(ops)
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('removeRow')
  })

  it('drops a row added then removed within the same log', () => {
    const ops: DatasetOp[] = [
      op({ type: 'addRow', row: -1 }),
      op({ type: 'setCell', row: -1, column: 'col_a', value: 'ephemeral' }),
      op({ type: 'removeRow', row: -1 }),
    ]
    expect(compactOps(ops)).toHaveLength(0)
  })

  it('drops a column added then removed within the same log', () => {
    const ops: DatasetOp[] = [
      op({ type: 'addColumn', column: 'col_tmp', name: 'tmp', colType: 'string' }),
      op({ type: 'setCell', row: 0, column: 'col_tmp', value: 'v' }),
      op({ type: 'removeColumn', column: 'col_tmp' }),
    ]
    expect(compactOps(ops)).toHaveLength(0)
  })

  it('keeps the removal of a column it did not add', () => {
    const out = compactOps([op({ type: 'removeColumn', column: 'col_a' })])
    expect(out).toHaveLength(1)
  })

  it('follows a renamed column when deciding what vanished', () => {
    const ops: DatasetOp[] = [
      op({ type: 'addColumn', column: 'col_tmp', name: 'tmp', colType: 'string' }),
      op({ type: 'renameColumn', column: 'col_tmp', to: 'col_final', toName: 'final' }),
      op({ type: 'removeColumn', column: 'col_final' }),
    ]
    expect(compactOps(ops)).toHaveLength(0)
  })

  it('preserves the replay result it compacts', () => {
    const ops: DatasetOp[] = [
      op({ type: 'setCell', row: 0, column: 'col_a', value: 'one' }),
      op({ type: 'setCell', row: 0, column: 'col_a', value: 'two' }),
      op({ type: 'addColumn', column: 'col_c', name: 'c', colType: 'number' }),
      op({ type: 'setCell', row: 2, column: 'col_c', value: 42 }),
      op({ type: 'removeRow', row: 1 }),
    ]
    expect(replayOps(base(), compactOps(ops))).toEqual(replayOps(base(), ops))
  })
})

describe('canonicalOp', () => {
  it('orders keys and drops absent fields', () => {
    const canonical = canonicalOp(
      op({ type: 'setCell', row: 0, column: 'col_a', value: 'v' }) as DatasetOp,
    )
    expect(Object.keys(canonical)).toEqual(['id', 'type', 'at', 'row', 'column', 'value'])
  })

  it('sorts the values map of an addRow so the diff does not churn', () => {
    const a = canonicalOp(op({ type: 'addRow', row: -1, values: { col_b: 'y', col_a: 'x' } }) as DatasetOp)
    const b = canonicalOp(op({ type: 'addRow', row: -1, values: { col_a: 'x', col_b: 'y' } }) as DatasetOp)
    expect(Object.keys(a.values as object)).toEqual(['col_a', 'col_b'])
    expect(JSON.stringify(a.values)).toBe(JSON.stringify(b.values))
  })

  it('emits an addColumn index without colliding with the timestamp', () => {
    const canonical = canonicalOp(
      op({ type: 'addColumn', column: 'col_c', name: 'c', colType: 'string', index: 2 }) as DatasetOp,
    )
    expect(canonical.index).toBe(2)
    expect(canonical.at).toBe(1_700_000_000_000)
  })

  it('drops a null in a metadata field, where null means absent', () => {
    // The Python twin drops these, so keeping them made the same log hash
    // differently on each side — and the digest is what invalidates the Parquet
    // cache. Nothing emits such an op today; this is what keeps that true.
    const canonical = canonicalOp(
      { ...op({ type: 'setCell', row: 0, column: 'col_a', value: 'v' }), by: null, group: null } as unknown as DatasetOp,
    )
    expect(canonical).not.toHaveProperty('by')
    expect(canonical).not.toHaveProperty('group')
  })

  it('keeps a null in value and after, where null is the meaning', () => {
    // An emptied cell and an append are both written as null; dropping either
    // would change what the op does on replay.
    const cell = canonicalOp(op({ type: 'setCell', row: 0, column: 'col_a', value: null }) as DatasetOp)
    expect(cell).toHaveProperty('value', null)

    const row = canonicalOp(op({ type: 'addRow', row: -1, after: null }) as DatasetOp)
    expect(row).toHaveProperty('after', null)
  })
})

describe('opsHash', () => {
  it('is stable across key insertion order', () => {
    const a = { id: 'a', at: 1, type: 'setCell', row: 0, column: 'col_a', value: 'v' } as DatasetOp
    const b = { value: 'v', column: 'col_a', row: 0, type: 'setCell', at: 1, id: 'a' } as DatasetOp
    expect(opsHash([a])).toBe(opsHash([b]))
  })

  it('changes when the log changes', () => {
    const one = [op<DatasetOp>({ type: 'setCell', row: 0, column: 'col_a', value: 'v' })]
    const two = [...one, op<DatasetOp>({ type: 'setCell', row: 1, column: 'col_a', value: 'w' })]
    expect(opsHash(one)).not.toBe(opsHash(two))
  })

  it('hashes an empty log to a stable value', () => {
    expect(opsHash([])).toBe(opsHash([]))
    expect(opsHash([])).toHaveLength(8)
  })
})

describe('retypeAddedColumn', () => {
  const added = (): DatasetOp[] => [
    op<DatasetOp>({ type: 'addColumn', column: 'col_dose', name: 'dose', colType: 'string' }),
    op<DatasetOp>({ type: 'setCell', row: 0, column: 'col_dose', value: '12' }),
  ]

  /** Stands in for the app's coerceValue/fitsColumnType pair. */
  const toNumber = (v: DatasetCellValue) => {
    const n = Number(String(v))
    return isNaN(n) ? null : n
  }

  it('retypes the column the log added', () => {
    const out = retypeAddedColumn(added(), 'col_dose', 'number')
    expect(out.changed).toBe(true)
    expect(out.ops[0]).toMatchObject({ type: 'addColumn', colType: 'number' })
  })

  it('makes the new type survive a replay — the whole point', () => {
    // Without this the column is re-created from the op's original colType on
    // every replay, so a type change silently reverted on the next edit.
    const out = replayOps(base(), retypeAddedColumn(added(), 'col_dose', 'number').ops)
    expect(out.columns.find((c) => c.id === 'col_dose')?.type).toBe('number')
  })

  it('converts the values already recorded', () => {
    // The replay never coerces, so without this the column reads `number` while
    // its cells stay the strings they were typed as.
    const out = retypeAddedColumn(added(), 'col_dose', 'number', toNumber)
    expect(out.ops[1]).toMatchObject({ value: 12 })
    expect(out.rejected).toEqual([])
  })

  it('keeps a value it cannot convert, and reports it', () => {
    // Blanking it would destroy something someone typed; the caller warns instead.
    const ops = [
      op<DatasetOp>({ type: 'addColumn', column: 'col_dose', name: 'dose', colType: 'string' }),
      op<DatasetOp>({ type: 'setCell', row: 0, column: 'col_dose', value: 'two pills' }),
    ]
    const out = retypeAddedColumn(ops, 'col_dose', 'number', toNumber)
    expect(out.ops[1]).toMatchObject({ value: 'two pills' })
    expect(out.rejected).toEqual(['two pills'])
  })

  it('does not report a blank cell as unconvertible', () => {
    const ops = [
      op<DatasetOp>({ type: 'addColumn', column: 'col_dose', name: 'dose', colType: 'string' }),
      op<DatasetOp>({ type: 'setCell', row: 0, column: 'col_dose', value: '' }),
      op<DatasetOp>({ type: 'setCell', row: 1, column: 'col_dose', value: null }),
    ]
    expect(retypeAddedColumn(ops, 'col_dose', 'number', toNumber).rejected).toEqual([])
  })

  it('converts only the retyped column', () => {
    const ops = [
      op<DatasetOp>({ type: 'addColumn', column: 'col_dose', name: 'dose', colType: 'string' }),
      op<DatasetOp>({ type: 'setCell', row: 0, column: 'col_other', value: '7' }),
    ]
    expect(retypeAddedColumn(ops, 'col_dose', 'number', toNumber).ops[1])
      .toMatchObject({ value: '7' })
  })

  it('reports no change for a column the log did not add', () => {
    // That is the caller's signal to fall back to parseOptions, which is where a
    // forced type belongs for a column that comes from the raw file.
    const ops = added()
    const out = retypeAddedColumn(ops, 'col_a', 'number', toNumber)
    expect(out.changed).toBe(false)
    expect(out.ops).toBe(ops)
    // No value is rewritten either — the parser will re-read them all.
    expect(out.rejected).toEqual([])
  })

  it('retypes every addColumn naming that id, and no other column', () => {
    const ops = [
      op<DatasetOp>({ type: 'addColumn', column: 'col_dose', name: 'dose', colType: 'string' }),
      op<DatasetOp>({ type: 'addColumn', column: 'col_unit', name: 'unit', colType: 'string' }),
    ]
    const out = retypeAddedColumn(ops, 'col_dose', 'date')
    expect(out.ops[0]).toMatchObject({ colType: 'date' })
    expect(out.ops[1]).toMatchObject({ colType: 'string' })
  })
})
