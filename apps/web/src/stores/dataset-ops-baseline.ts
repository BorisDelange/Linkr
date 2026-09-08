/**
 * Baseline reconstruction for the dataset edit log.
 *
 * Undo builds each inverse against the state its op saw, which means replaying the
 * log forward from the UNEDITED parsed rows. Neither mode hands those over:
 * front-only holds the already-replayed rows in memory, and server mode pages the
 * already-replayed Parquet cache. Re-deriving from either would apply the log
 * twice, so the baseline is reconstructed by removing what the log added.
 */
import { ROW_ORD, type DatasetOp, type ReplayInput } from '@linkr/format'

/**
 * Recover the pre-op state from an already-replayed one.
 *
 * Every effect the log had on a cell must be undone here, not just the rows it
 * added: an inverse is computed against the value its op REPLACED, so handing back
 * a state that still holds the edited value makes `setCell 'new'` invert to
 * `setCell 'new'` — an undo that silently does nothing.
 *
 * Ops are walked backwards, each one restoring what it overwrote, which is
 * recoverable because a cell's prior value is the value the *earlier* op wrote (or
 * the raw one, when no earlier op touched it).
 *
 * Two things stay unrecoverable, and callers must not depend on them: a row or
 * column the log REMOVED cannot be resurrected from a state it is absent from.
 * That is fine for building inverses — `invertOpFull` reads removed-column values
 * from the state as it was *before* that op, which this reconstruction does
 * provide — but it means this is a baseline reconstruction, NOT a true inverse of
 * `replayOps`.
 */
export function unreplay(state: ReplayInput, ops: readonly DatasetOp[]): ReplayInput {
  const rows = state.rows.map((r, i) => ({ ...r, [ROW_ORD]: (r[ROW_ORD] as number) ?? i }))
  if (!ops.length) return { columns: state.columns, rows }

  const byOrdinal = new Map<number, Record<string, unknown>>()
  for (const row of rows) byOrdinal.set(row[ROW_ORD] as number, row)

  // Backwards: the value a setCell replaced is whatever the log held for that cell
  // just before it, so rewinding in reverse order lands on the raw value.
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]
    if (op.type !== 'setCell') continue
    const row = byOrdinal.get(op.row)
    if (!row) continue
    row[op.column] = priorValue(ops, i, op.row, op.column)
  }

  const addedRows = new Set<number>()
  const addedColumns = new Set<string>()
  for (const op of ops) {
    if (op.type === 'addRow') addedRows.add(op.row)
    if (op.type === 'addColumn') addedColumns.add(op.column)
  }

  const columns = state.columns.filter((c) => !addedColumns.has(c.id))
  const kept = rows.filter((r) => !addedRows.has(r[ROW_ORD] as number))
  for (const row of kept) for (const id of addedColumns) delete row[id]
  return { columns, rows: kept }
}

/**
 * What a cell held just before `ops[index]` wrote it: the last earlier write, or
 * null when the log is the only thing that ever put a value there.
 *
 * Returning null for an untouched cell is deliberate — a raw cell's value is
 * unknowable from a replayed state, but a cell the log never wrote is never
 * rewound either, so that case cannot arise from the loop above.
 */
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
  return null
}
