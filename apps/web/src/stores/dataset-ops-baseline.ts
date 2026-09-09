/**
 * Baseline reconstruction for the dataset edit log.
 *
 * Undo drops the last action from the log and replays what remains, so it needs the
 * UNEDITED parsed rows to replay over. Neither mode hands those over: front-only
 * holds the already-replayed rows in memory, and server mode pages the
 * already-replayed Parquet cache. Re-deriving from either would apply the log
 * twice, so the baseline is reconstructed by rewinding what the log did.
 */
import { ROW_ORD, type DatasetOp, type ReplayInput } from '@linkr/format'

/**
 * Recover the pre-op state from an already-replayed one.
 *
 * Every effect the log had must be rewound, not just the rows it added: this
 * result is REPLAYED OVER, so anything left in an edited state would be treated as
 * the source data and re-applied on top of itself.
 *
 * A cell is rewound only when the log can say what it held before — the value an
 * earlier op wrote. A cell the log wrote only once keeps what it currently holds:
 * its raw value is genuinely unknowable from a replayed state, and blanking it
 * would destroy real data to satisfy a reconstruction. Replaying the log forward
 * re-applies that op anyway, so the visible result is identical; only an undo of
 * that particular op cannot recover the original — the one limit of deriving a
 * baseline instead of re-reading the raw file.
 */
export function unreplay(state: ReplayInput, ops: readonly DatasetOp[]): ReplayInput {
  // Annotated: spreading with a computed key narrows the inferred type to just that
  // key, which drops the index signature the column reads below need.
  const rows: Record<string, unknown>[] = state.rows.map(
    (r, i) => ({ ...r, [ROW_ORD]: (r[ROW_ORD] as number) ?? i }),
  )
  if (!ops.length) return { columns: state.columns, rows }

  const byOrdinal = new Map<number, Record<string, unknown>>()
  for (const row of rows) byOrdinal.set(row[ROW_ORD] as number, row)

  // Backwards: the value a setCell replaced is whatever the log held for that cell
  // just before it, so rewinding in reverse order lands on the earliest known one.
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]
    if (op.type !== 'setCell') continue
    const row = byOrdinal.get(op.row)
    if (!row) continue
    const prior = priorValue(ops, i, op.row, op.column)
    if (prior !== UNKNOWN) row[op.column] = prior
  }

  const addedRows = new Set<number>()
  const addedColumns = new Set<string>()
  for (const op of ops) {
    if (op.type === 'addRow') addedRows.add(op.row)
    if (op.type === 'addColumn') addedColumns.add(op.column)
  }
  // A column the log added AND later removed is already gone from `state`; only
  // one still present needs stripping.
  for (const op of ops) if (op.type === 'removeColumn') addedColumns.delete(op.column)

  const columns = state.columns.filter((c) => !addedColumns.has(c.id))
  const kept = rows.filter((r) => !addedRows.has(r[ROW_ORD] as number))
  for (const row of kept) for (const id of addedColumns) delete row[id]
  return { columns, rows: kept }
}

/** No earlier op wrote this cell, so its previous value is not in the log. */
const UNKNOWN = Symbol('unknown')

/** What a cell held just before `ops[index]` wrote it, or UNKNOWN if the log
 *  never says. */
function priorValue(
  ops: readonly DatasetOp[],
  index: number,
  row: number,
  column: string,
): unknown {
  for (let i = index - 1; i >= 0; i--) {
    const op = ops[i]
    if (op.type === 'setCell' && op.row === row && op.column === column) return op.value
    if (op.type === 'addRow' && op.row === row) return op.values?.[column] ?? null
  }
  return UNKNOWN
}
