/**
 * Cell selection and in-place editing for the dataset table.
 *
 * Cells are addressed by ROW ORDINAL, never by screen position: the table shows a
 * sorted, filtered, paginated slice, and in server mode it only ever holds one
 * page, so an index into the visible rows means nothing to the edit log. The
 * ordinal comes from the replayed rows themselves (`__row_ord`).
 *
 * Every committed edit becomes an op; nothing here mutates rows directly.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ROW_ORD, type DatasetCellValue, type DatasetOp } from '@linkr/format'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetColumn } from '@/types'

export interface CellAddress {
  row: number
  column: string
}

/** Parse a typed string back to the column's type, so DuckDB gets real values. */
export function parseCellInput(raw: string, type: DatasetColumn['type']): DatasetCellValue {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (type === 'number') {
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : trimmed
  }
  if (type === 'boolean') {
    const lowered = trimmed.toLowerCase()
    if (['true', '1', 'yes', 'y'].includes(lowered)) return true
    if (['false', '0', 'no', 'n'].includes(lowered)) return false
    return trimmed
  }
  return trimmed
}

/** The editable string form of a stored value (the inverse of parseCellInput). */
export function cellInputValue(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (raw instanceof Date) return raw.toISOString().slice(0, 10)
  return String(raw)
}

interface Options {
  fileId: string
  /** Rows of the current page, in display order. */
  rows: Record<string, unknown>[]
  /** Columns in display order — arrow keys walk this, not the stored order. */
  columns: DatasetColumn[]
  enabled: boolean
}

export function useCellEditing({ fileId, rows, columns, enabled }: Options) {
  const applyOps = useDatasetStore((s) => s.applyOps)
  const [selected, setSelected] = useState<CellAddress | null>(null)
  const [editing, setEditing] = useState<CellAddress | null>(null)
  const [draft, setDraft] = useState('')
  // Mirrored into refs so the commit path — and the window key handler that calls
  // it — read the latest values without re-subscribing on every keystroke.
  const draftRef = useRef(draft)
  useEffect(() => { draftRef.current = draft }, [draft])
  const editingRef = useRef<CellAddress | null>(editing)
  useEffect(() => { editingRef.current = editing }, [editing])

  const ordinalOf = useCallback(
    (row: Record<string, unknown>) => row[ROW_ORD] as number | undefined,
    [],
  )

  const beginEdit = useCallback((address: CellAddress, current: unknown) => {
    if (!enabled) return
    setSelected(address)
    editingRef.current = address
    setEditing(address)
    setDraft(cellInputValue(current))
  }, [enabled])

  const cancelEdit = useCallback(() => {
    // Ref first, for the same reason as commitEdit: unmounting the input fires
    // onBlur, which would otherwise commit the draft the user just discarded.
    editingRef.current = null
    setEditing(null)
  }, [])

  const commitEdit = useCallback(async () => {
    const target = editingRef.current
    if (!target) return
    // Cleared through the ref too, and synchronously: ending an edit unmounts the
    // input, whose onBlur calls straight back in here. Waiting for the state
    // update meant the second call still saw the old target and re-committed a
    // stale draft — which is what silently dropped an edit committed with Enter.
    editingRef.current = null
    setEditing(null)

    const column = columns.find((c) => c.id === target.column)
    if (!column) return
    const row = rows.find((r) => ordinalOf(r) === target.row)
    const next = parseCellInput(draftRef.current, column.type)
    // An unchanged value must not record an op: the log is the audit trail, and
    // clicking through cells would otherwise fill it with noise.
    if (row && sameCell(row[target.column], next)) return

    const op: DatasetOp = {
      id: crypto.randomUUID(),
      at: Date.now(),
      type: 'setCell',
      row: target.row,
      column: target.column,
      value: next,
    }
    await applyOps(fileId, [op])
  }, [applyOps, columns, fileId, ordinalOf, rows])

  /** Move the selection by a delta within the current page. */
  const move = useCallback((dRow: number, dCol: number) => {
    setSelected((current) => {
      if (!current) return current
      const rowIndex = rows.findIndex((r) => ordinalOf(r) === current.row)
      const colIndex = columns.findIndex((c) => c.id === current.column)
      if (rowIndex < 0 || colIndex < 0) return current

      const nextRow = clamp(rowIndex + dRow, 0, rows.length - 1)
      const nextCol = clamp(colIndex + dCol, 0, columns.length - 1)
      const ordinal = ordinalOf(rows[nextRow])
      if (ordinal === undefined) return current
      return { row: ordinal, column: columns[nextCol].id }
    })
  }, [columns, ordinalOf, rows])

  useEffect(() => {
    if (!enabled || !selected) return

    const onKeyDown = (e: KeyboardEvent) => {
      // While editing, only the keys that end the edit are ours — everything else
      // belongs to the input.
      if (editing) {
        if (e.key === 'Enter') { e.preventDefault(); void commitEdit(); move(1, 0) }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
        else if (e.key === 'Tab') { e.preventDefault(); void commitEdit(); move(0, e.shiftKey ? -1 : 1) }
        return
      }

      // Don't steal keys from a filter box or any other real input.
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

      switch (e.key) {
        case 'ArrowUp': e.preventDefault(); move(-1, 0); break
        case 'ArrowDown': e.preventDefault(); move(1, 0); break
        case 'ArrowLeft': e.preventDefault(); move(0, -1); break
        case 'ArrowRight': e.preventDefault(); move(0, 1); break
        case 'Tab': e.preventDefault(); move(0, e.shiftKey ? -1 : 1); break
        case 'Enter': {
          e.preventDefault()
          const row = rows.find((r) => ordinalOf(r) === selected.row)
          beginEdit(selected, row?.[selected.column])
          break
        }
        case 'Delete':
        case 'Backspace': {
          e.preventDefault()
          void applyOps(fileId, [{
            id: crypto.randomUUID(), at: Date.now(), type: 'setCell',
            row: selected.row, column: selected.column, value: null,
          }])
          break
        }
        case 'Escape': setSelected(null); break
        default:
          // A printable key starts an edit with that character, as a spreadsheet does.
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            editingRef.current = selected
            setEditing(selected)
            setDraft(e.key)
          }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applyOps, beginEdit, cancelEdit, commitEdit, editing, enabled, fileId, move, ordinalOf, rows, selected])

  return {
    selected, setSelected,
    editing, draft, setDraft,
    beginEdit, cancelEdit, commitEdit,
    ordinalOf,
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(n, max))
}

/** Compare a stored cell against a parsed input, tolerating the string/number gap
 *  a CSV parse leaves behind (a column typed `number` can still hold "70"). */
function sameCell(stored: unknown, next: DatasetCellValue): boolean {
  if (stored === next) return true
  if (stored == null && next == null) return true
  if (stored == null || next == null) return false
  return String(stored) === String(next)
}
