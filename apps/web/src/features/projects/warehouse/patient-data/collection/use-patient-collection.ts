/**
 * Manual data collection for the patient chart.
 *
 * What a clinician types here lands in an ordinary dataset — the same one the
 * Datasets page edits and the Timeline can plot — so a hand-collected variable is
 * a first-class dataset from the moment it is captured, rather than a separate
 * store to reconcile later. Writes go through the edit log, which is what gives
 * collection its undo and its provenance for nothing.
 *
 * One row per (patient, visit, visit detail) as the config declares: filling a
 * field for a patient who already has a row UPDATES that row rather than adding a
 * second one, because a collection is a form, not an append-only journal.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ROW_ORD, type DatasetOp } from '@linkr/format'
import { isServerMode } from '@/lib/api-client'
import { queryDatasetRows } from '@/lib/api/datasets'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetColumn, PatientCollectionConfig } from '@/types'

export interface CollectionField {
  column: DatasetColumn
  value: unknown
}

interface PatientKey {
  personId: string | null
  visitId: string | null
  visitDetailId: string | null
}

export function usePatientCollection(config: PatientCollectionConfig | undefined, key: PatientKey) {
  const fileId = config?.datasetFileId
  const file = useDatasetStore((s) => s.files.find((f) => f.id === fileId))
  const applyOps = useDatasetStore((s) => s.applyOps)
  const loadFileData = useDatasetStore((s) => s.loadFileData)
  const getFileRows = useDatasetStore((s) => s.getFileRows)
  const dirtyVersion = useDatasetStore((s) => s._dirtyVersion)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])

  useEffect(() => {
    if (!fileId) {
      setRows([])
      return
    }
    let cancelled = false
    if (isServerMode()) {
      queryDatasetRows(fileId, { offset: 0, limit: 50_000 })
        .then((page) => { if (!cancelled) setRows(page.rows) })
        .catch(() => { if (!cancelled) setRows([]) })
    } else {
      void loadFileData(fileId).then(() => {
        if (!cancelled) setRows(getFileRows(fileId))
      })
    }
    return () => { cancelled = true }
  }, [fileId, loadFileData, getFileRows, dirtyVersion])

  /** The row already holding this patient's collection, when there is one. */
  const currentRow = useMemo(() => {
    if (!config?.personColumn || !key.personId) return undefined
    return rows.find((row) => {
      if (String(row[config.personColumn] ?? '') !== key.personId) return false
      if (config.visitColumn && key.visitId) {
        if (String(row[config.visitColumn] ?? '') !== key.visitId) return false
      }
      if (config.visitDetailColumn && key.visitDetailId) {
        if (String(row[config.visitDetailColumn] ?? '') !== key.visitDetailId) return false
      }
      return true
    })
  }, [rows, config, key.personId, key.visitId, key.visitDetailId])

  /** The columns offered as fields: everything that is not an identity column. */
  const fields = useMemo<CollectionField[]>(() => {
    if (!config || !file?.columns) return []
    const identity = new Set(
      [config.personColumn, config.visitColumn, config.visitDetailColumn].filter(Boolean) as string[],
    )
    const chosen = config.variableColumns?.length
      ? config.variableColumns
      : file.columns.filter((c) => !identity.has(c.id)).map((c) => c.id)

    return chosen
      .map((id) => file.columns!.find((c) => c.id === id))
      .filter((c): c is DatasetColumn => c != null && !identity.has(c.id))
      .map((column) => ({ column, value: currentRow?.[column.id] ?? null }))
  }, [config, file?.columns, currentRow])

  const filledCount = fields.filter((f) => f.value != null && f.value !== '').length

  /** Write one field, creating the patient's row on the first value entered. */
  const setValue = useCallback(async (columnId: string, value: string | number | boolean | null) => {
    if (!config || !fileId || !key.personId) return
    const group = crypto.randomUUID()

    if (currentRow) {
      await applyOps(fileId, [{
        id: crypto.randomUUID(), at: Date.now(), group,
        type: 'setCell', row: currentRow[ROW_ORD] as number, column: columnId, value,
      }])
      return
    }

    // No row yet: create one carrying the identity columns AND this first value,
    // as a single op so an undo removes the whole row rather than blanking a cell
    // in a row that should never have existed.
    const lowest = Math.min(
      0,
      ...(file?.ops ?? []).filter((o): o is Extract<DatasetOp, { type: 'addRow' }> => o.type === 'addRow')
        .map((o) => o.row),
    )
    const values: Record<string, string | number | boolean | null> = {
      [config.personColumn]: key.personId,
      [columnId]: value,
    }
    if (config.visitColumn && key.visitId) values[config.visitColumn] = key.visitId
    if (config.visitDetailColumn && key.visitDetailId) values[config.visitDetailColumn] = key.visitDetailId

    await applyOps(fileId, [{
      id: crypto.randomUUID(), at: Date.now(), group,
      type: 'addRow', row: lowest - 1, values,
    }])
  }, [applyOps, config, currentRow, file?.ops, fileId, key.personId, key.visitId, key.visitDetailId])

  return {
    dataset: file,
    fields,
    filledCount,
    hasRow: currentRow != null,
    setValue,
  }
}
