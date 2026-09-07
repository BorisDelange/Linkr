/**
 * Dataset edit operations — the ordered, replayable log that makes a dataset
 * editable without ever touching its raw file.
 *
 * A dataset's raw file on disk is immutable (see docs/architecture.md § Datasets).
 * Edits are therefore recorded as operations, and the materialised form is derived:
 *
 *     raw → parse(parseOptions) → replay(ops) → parquet cache
 *
 * The log lives in the `ops` section of the dataset's sidecar and is appended to,
 * never rewritten in place, so two people collecting on different patients cannot
 * drop each other's work.
 *
 * This MUST stay a faithful twin of the Python port
 * (apps/api/app/services/data/dataset_ops.py): the client replays to render, the
 * server replays to build the Parquet cache, and a drift means the two disagree
 * about what the dataset contains. A shared fixture + parity tests guard this
 * (see dataset-ops.fixture.json).
 */

/**
 * Stable row identity.
 *
 * Row position cannot be the key: ops are recorded against a sorted, filtered,
 * paginated view, and in server mode the client never even sees the full order.
 * The raw file's ordinal can be the key precisely because the raw is immutable —
 * row 41 is row 41 forever.
 *
 * Rows added by an op have no raw ordinal, so they take *negative* ones, assigned
 * decreasing from -1. Negative space is disjoint from raw space by construction,
 * so an added row can never collide with a raw row, whatever the file's length.
 */
export const ROW_ORD = '__row_ord'

export type DatasetOpType =
  | 'setCell'
  | 'addRow'
  | 'removeRow'
  | 'reorderRows'
  | 'addColumn'
  | 'removeColumn'
  | 'reorderColumns'
  | 'renameColumn'

export type DatasetCellValue = string | number | boolean | null

/** Column type vocabulary, matching `DatasetColumn['type']` in the app. */
export type DatasetOpColumnType = 'string' | 'number' | 'boolean' | 'date' | 'unknown'

interface OpBase {
  /** Unique, so an append is idempotent and an undo can name its target. */
  id: string
  /** Epoch ms. Ordering is by position in the log, never by this. */
  at: number
  /** Who made the edit — a user id when known. Provenance for manual collection. */
  by?: string
}

export interface SetCellOp extends OpBase {
  type: 'setCell'
  row: number
  column: string
  value: DatasetCellValue
}

export interface AddRowOp extends OpBase {
  type: 'addRow'
  row: number
  values?: Record<string, DatasetCellValue>
  /** Raw ordinal to insert after; omitted (or null) appends at the end. */
  after?: number | null
}

export interface RemoveRowOp extends OpBase {
  type: 'removeRow'
  row: number
}

export interface ReorderRowsOp extends OpBase {
  type: 'reorderRows'
  /** Row ordinals in their new relative order. Rows left out keep their place. */
  order: number[]
}

export interface AddColumnOp extends OpBase {
  type: 'addColumn'
  column: string
  name: string
  colType: DatasetOpColumnType
  /** Insertion index in column order; appended when omitted. Named `index`, not
   *  `at`, because `at` is already the op timestamp on every op. */
  index?: number
}

export interface RemoveColumnOp extends OpBase {
  type: 'removeColumn'
  column: string
}

export interface ReorderColumnsOp extends OpBase {
  type: 'reorderColumns'
  /** Column ids in their new order. Ids left out keep their relative place after. */
  order: string[]
}

/**
 * A rename is a *rekey*: column ids are derived from the name (`col_<slug>`), so
 * the physical row key changes with it and every downstream reference — widget
 * configs, dashboard filters — has to be repaired. Route it through
 * `renameDatasetColumns` in rekey.ts rather than repairing by hand.
 */
export interface RenameColumnOp extends OpBase {
  type: 'renameColumn'
  column: string
  to: string
  toName: string
}

export type DatasetOp =
  | SetCellOp
  | AddRowOp
  | RemoveRowOp
  | ReorderRowsOp
  | AddColumnOp
  | RemoveColumnOp
  | ReorderColumnsOp
  | RenameColumnOp

/** A column as the replay engine sees it — the subset of `DatasetColumn` it needs. */
export interface OpColumn {
  id: string
  name: string
  type: DatasetOpColumnType
  order: number
  label?: string
  description?: string
  valueLabels?: Record<string, string>
}

export type OpRow = Record<string, unknown>

export interface ReplayInput {
  columns: OpColumn[]
  rows: OpRow[]
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Apply `ops` in order to a parsed dataset, returning the materialised result.
 *
 * Rows are keyed by `ROW_ORD`, which is assigned here when absent: the input is
 * the freshly parsed raw file, so its ordinals are simply its positions. The
 * output carries `ROW_ORD` on every row — the cache stores it, so a later replay
 * of appended ops addresses the same rows.
 *
 * Unknown op types and ops naming a missing row/column are skipped rather than
 * throwing: a log outlives the schema it was written against (a column can be
 * dropped by a reimport), and one stale op must not make a dataset unreadable.
 */
export function replayOps(input: ReplayInput, ops: readonly DatasetOp[]): ReplayInput {
  const columns: OpColumn[] = input.columns.map((c) => ({ ...c }))
  const rows: OpRow[] = input.rows.map((r, i) => ({ ...r, [ROW_ORD]: (r[ROW_ORD] as number) ?? i }))

  let nextAdded = -1
  for (const row of rows) {
    const ord = row[ROW_ORD] as number
    if (ord <= nextAdded) nextAdded = ord - 1
  }

  for (const op of ops) {
    switch (op.type) {
      case 'setCell': {
        const row = rows.find((r) => r[ROW_ORD] === op.row)
        if (row && columns.some((c) => c.id === op.column)) row[op.column] = op.value
        break
      }
      case 'addRow': {
        if (rows.some((r) => r[ROW_ORD] === op.row)) break
        const row: OpRow = { [ROW_ORD]: op.row }
        for (const col of columns) row[col.id] = op.values?.[col.id] ?? null
        if (op.row <= nextAdded) nextAdded = op.row - 1
        const at = op.after == null ? -1 : rows.findIndex((r) => r[ROW_ORD] === op.after)
        if (at < 0) rows.push(row)
        else rows.splice(at + 1, 0, row)
        break
      }
      case 'removeRow': {
        const at = rows.findIndex((r) => r[ROW_ORD] === op.row)
        if (at >= 0) rows.splice(at, 1)
        break
      }
      case 'reorderRows': {
        applyReorder(rows, op.order, (r) => r[ROW_ORD] as number)
        break
      }
      case 'addColumn': {
        if (columns.some((c) => c.id === op.column)) break
        const at = op.index == null ? columns.length : Math.max(0, Math.min(op.index, columns.length))
        columns.splice(at, 0, { id: op.column, name: op.name, type: op.colType, order: at })
        renumber(columns)
        for (const row of rows) row[op.column] = null
        break
      }
      case 'removeColumn': {
        const at = columns.findIndex((c) => c.id === op.column)
        if (at < 0) break
        columns.splice(at, 1)
        renumber(columns)
        for (const row of rows) delete row[op.column]
        break
      }
      case 'reorderColumns': {
        applyReorder(columns, op.order, (c) => c.id)
        renumber(columns)
        break
      }
      case 'renameColumn': {
        const col = columns.find((c) => c.id === op.column)
        if (!col || columns.some((c) => c.id === op.to)) break
        col.id = op.to
        col.name = op.toName
        for (const row of rows) {
          row[op.to] = row[op.column]
          delete row[op.column]
        }
        break
      }
    }
  }

  return { columns, rows }
}

/**
 * Reorder `items` so the members named in `order` appear in that sequence, at the
 * positions those members currently occupy. Items not named keep their slots, so a
 * partial order (the common case: dragging one column) leaves the rest untouched.
 */
function applyReorder<T>(items: T[], order: readonly (string | number)[], keyOf: (item: T) => string | number): void {
  const named = new Set(order)
  const slots: number[] = []
  for (const [i, item] of items.entries()) if (named.has(keyOf(item))) slots.push(i)

  const byKey = new Map(items.map((item) => [keyOf(item), item]))
  const moved = order.map((k) => byKey.get(k)).filter((item): item is T => item !== undefined)
  for (const [i, slot] of slots.entries()) if (i < moved.length) items[slot] = moved[i]
}

function renumber(columns: OpColumn[]): void {
  for (const [i, col] of columns.entries()) col.order = i
}

// ---------------------------------------------------------------------------
// Inverses — the undo mechanism
// ---------------------------------------------------------------------------

/**
 * The op that undoes `op`, given the state it was applied to, or null when the op
 * had no effect (so there is nothing to undo).
 *
 * Undo is *not* the closure-based `UndoAction` stack in dataset-store: that one is
 * neither serialisable nor replayable and dies with the tab. An inverse is itself
 * an op, so it appends to the log like any other edit and survives a reload.
 *
 * `state` must be the dataset as it was *before* `op` was applied — the inverse of
 * a setCell needs the value it overwrote, and the inverse of a removeRow needs the
 * row it deleted.
 */
export function invertOp(op: DatasetOp, state: ReplayInput, meta: OpBase): DatasetOp | null {
  switch (op.type) {
    case 'setCell': {
      const row = state.rows.find((r) => r[ROW_ORD] === op.row)
      if (!row || !state.columns.some((c) => c.id === op.column)) return null
      return { ...meta, type: 'setCell', row: op.row, column: op.column, value: cellValue(row[op.column]) }
    }
    case 'addRow':
      return { ...meta, type: 'removeRow', row: op.row }
    case 'removeRow': {
      const at = state.rows.findIndex((r) => r[ROW_ORD] === op.row)
      if (at < 0) return null
      const row = state.rows[at]
      const values: Record<string, DatasetCellValue> = {}
      for (const col of state.columns) values[col.id] = cellValue(row[col.id])
      const after = at > 0 ? (state.rows[at - 1][ROW_ORD] as number) : null
      return { ...meta, type: 'addRow', row: op.row, values, after }
    }
    case 'reorderRows':
      return { ...meta, type: 'reorderRows', order: state.rows.map((r) => r[ROW_ORD] as number) }
    case 'addColumn':
      return { ...meta, type: 'removeColumn', column: op.column }
    case 'removeColumn': {
      const at = state.columns.findIndex((c) => c.id === op.column)
      if (at < 0) return null
      const col = state.columns[at]
      // A removeColumn drops the whole column's data; restoring the shape is not
      // enough, so the inverse re-adds it and then restores each cell.
      return { ...meta, type: 'addColumn', column: col.id, name: col.name, colType: col.type, index: at }
    }
    case 'reorderColumns':
      return { ...meta, type: 'reorderColumns', order: state.columns.map((c) => c.id) }
    case 'renameColumn': {
      const col = state.columns.find((c) => c.id === op.column)
      if (!col) return null
      return { ...meta, type: 'renameColumn', column: op.to, to: op.column, toName: col.name }
    }
  }
}

/**
 * The ops that undo `op` completely — `invertOp` plus, for a column removal, the
 * setCells that restore its data. A single inverse cannot carry the cells, so undo
 * consumes a list.
 */
export function invertOpFull(op: DatasetOp, state: ReplayInput, mint: () => OpBase): DatasetOp[] {
  const head = invertOp(op, state, mint())
  if (!head) return []
  if (op.type !== 'removeColumn') return [head]

  const restored: DatasetOp[] = [head]
  for (const row of state.rows) {
    const value = cellValue(row[op.column])
    if (value === null) continue
    restored.push({ ...mint(), type: 'setCell', row: row[ROW_ORD] as number, column: op.column, value })
  }
  return restored
}

function cellValue(raw: unknown): DatasetCellValue {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw
  if (raw instanceof Date) return raw.toISOString()
  return String(raw)
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * Collapse a log to the shortest one with the same result.
 *
 * Replay is linear in the log, so without this the cost tracks the number of
 * *clicks*; with it, it tracks the number of *cells touched*. Filling one cell
 * fifty times leaves one op.
 *
 * Only unambiguously safe collapses are made — a later setCell supersedes an
 * earlier one on the same (row, column); ops on a row or column that is later
 * removed are dropped, as is the removal of a row or column added within the same
 * log. Reorders are kept as-is: they are cheap and their interaction with
 * insertions is order-sensitive.
 *
 * Compaction rewrites the whole log, so it is a replace, never an append.
 */
export function compactOps(ops: readonly DatasetOp[]): DatasetOp[] {
  const removedRows = new Set<number>()
  const removedColumns = new Set<string>()
  const addedRows = new Set<number>()
  const addedColumns = new Set<string>()

  for (const op of ops) {
    switch (op.type) {
      case 'addRow':
        addedRows.add(op.row)
        removedRows.delete(op.row)
        break
      case 'removeRow':
        removedRows.add(op.row)
        break
      case 'addColumn':
        addedColumns.add(op.column)
        removedColumns.delete(op.column)
        break
      case 'removeColumn':
        removedColumns.add(op.column)
        break
      // A rename moves the identity, so anything known about the old id has to
      // follow it — otherwise a later op on the new id looks unrelated.
      case 'renameColumn':
        if (removedColumns.delete(op.column)) removedColumns.add(op.to)
        if (addedColumns.delete(op.column)) addedColumns.add(op.to)
        break
    }
  }

  // A row/column both added and removed in this log leaves no trace, so every op
  // naming it can go. One only removed must keep its removal.
  const vanishedRows = new Set([...removedRows].filter((r) => addedRows.has(r)))
  const vanishedColumns = new Set([...removedColumns].filter((c) => addedColumns.has(c)))

  // A column's id changes under a rename, but the sets above are keyed by its
  // FINAL id — so each op must be judged under the identity its column ends up
  // with, not the one it was written against.
  const finalId = new Map<string, string>()
  for (const op of ops) {
    if (op.type !== 'renameColumn') continue
    const origin = [...finalId.entries()].find(([, id]) => id === op.column)?.[0] ?? op.column
    finalId.set(origin, op.to)
  }
  const resolve = (column: string) => finalId.get(column) ?? column
  const cellKey = (row: number, column: string) => `${row} ${resolve(column)}`

  const lastCell = new Map<string, number>()
  ops.forEach((op, i) => {
    if (op.type === 'setCell') lastCell.set(cellKey(op.row, op.column), i)
  })

  const out: DatasetOp[] = []
  ops.forEach((op, i) => {
    switch (op.type) {
      case 'setCell':
        if (lastCell.get(cellKey(op.row, op.column)) !== i) return
        if (removedRows.has(op.row) || removedColumns.has(resolve(op.column))) return
        break
      case 'addRow':
      case 'removeRow':
        if (vanishedRows.has(op.row)) return
        break
      case 'addColumn':
      case 'removeColumn':
        if (vanishedColumns.has(resolve(op.column))) return
        break
      case 'renameColumn':
        if (vanishedColumns.has(resolve(op.to))) return
        break
    }
    out.push(op)
  })

  return out
}

// ---------------------------------------------------------------------------
// Canonical form & hashing
// ---------------------------------------------------------------------------

const OP_KEY_ORDER = [
  'id', 'type', 'at', 'by',
  'row', 'column', 'value', 'values', 'after', 'order',
  'name', 'colType', 'index', 'to', 'toName',
] as const

/**
 * An op with its keys in a fixed order and its absent fields dropped.
 *
 * The sidecar is written verbatim by both the TS and the Python export builders,
 * so key insertion order would otherwise depend on write history and churn the git
 * diff — the same reason `parseOptions` is canonicalised server-side.
 */
export function canonicalOp(op: DatasetOp): Record<string, unknown> {
  const src = op as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of OP_KEY_ORDER) {
    const value = src[key]
    if (value === undefined) continue
    out[key] = key === 'values' ? sortedRecord(value as Record<string, unknown>) : value
  }
  return out
}

function sortedRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(rec).sort()) out[k] = rec[k]
  return out
}

export function canonicalOps(ops: readonly DatasetOp[]): Record<string, unknown>[] {
  return ops.map(canonicalOp)
}

/**
 * A stable digest of the log, used to invalidate the Parquet cache: the cache is
 * `raw → parse → replay`, so it goes stale when the raw changes (already covered
 * by its (mtime, size) signature) *or* when the log does.
 *
 * FNV-1a over the canonical JSON — this only ever compares against itself, so a
 * short non-cryptographic digest is the right tool.
 */
export function opsHash(ops: readonly DatasetOp[]): string {
  const json = JSON.stringify(canonicalOps(ops))
  let hash = 0x811c9dc5
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
