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
 * Only rows carrying a raw ordinal survive: a row the log added has no raw
 * counterpart, and one it removed cannot be resurrected from a state it is absent
 * from. That suffices for building inverses — they address raw ordinals, and
 * replaying the log forward re-applies every cell value — but it means this is a
 * baseline reconstruction, NOT a true inverse of `replayOps`.
 */
export function unreplay(state: ReplayInput, ops: readonly DatasetOp[]): ReplayInput {
  const rows = state.rows.map((r, i) => ({ ...r, [ROW_ORD]: (r[ROW_ORD] as number) ?? i }))
  if (!ops.length) return { columns: state.columns, rows }

  const added = new Set<number>()
  for (const op of ops) if (op.type === 'addRow') added.add(op.row)
  return { columns: state.columns, rows: rows.filter((r) => !added.has(r[ROW_ORD] as number)) }
}
