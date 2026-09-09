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
import { useAppStore } from '@/stores/app-store'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetColumn, PatientCollectionConfig } from '@/types'
import { resolveVariables } from './variables'

export interface CollectionField {
  column: DatasetColumn
  value: unknown
}

interface PatientKey {
  personId: string | null
  visitId: string | null
  visitDetailId: string | null
}

export function usePatientCollection(
  config: PatientCollectionConfig | undefined,
  key: PatientKey,
  /**
   * The project owning the collection dataset. Passed in rather than read from
   * `PatientChartContext`: the page calls this hook ABOVE its own Provider, so the
   * context there is still the default one whose `projectUid` is `''` — which left
   * the datasets unloaded until the Datasets page had been visited.
   */
  projectUid: string,
) {
  const fileId = config?.datasetFileId
  const file = useDatasetStore((s) => s.files.find((f) => f.id === fileId))
  const applyOps = useDatasetStore((s) => s.applyOps)
  const loadFileData = useDatasetStore((s) => s.loadFileData)
  const loadProjectDatasets = useDatasetStore((s) => s.loadProjectDatasets)
  const ensureServerMeta = useDatasetStore((s) => s.ensureServerMeta)
  const getFileRows = useDatasetStore((s) => s.getFileRows)
  const dirtyVersion = useDatasetStore((s) => s._dirtyVersion)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const datasetsPath = useAppStore(
    (s) => s._projectsRaw.find((p) => p.uid === projectUid)?.datasetsPath,
  )

  // The datasets live in their own store, which only the Datasets page was loading —
  // so collecting without having visited that page found no file at all, and the
  // panel reported the dataset as having no columns. The store no-ops when this
  // project is already scanned.
  useEffect(() => {
    if (projectUid) void loadProjectDatasets(projectUid, datasetsPath ?? undefined)
  }, [projectUid, datasetsPath, loadProjectDatasets])

  // Server mode lists a dataset without its columns; they arrive on demand.
  useEffect(() => {
    if (fileId) void ensureServerMeta(fileId)
  }, [fileId, ensureServerMeta])

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

  /** The fields to fill, resolved from the configured variables. */
  const fields = useMemo<CollectionField[]>(() => {
    if (!config || !file?.columns) return []
    const variables = resolveVariables(config.variables, file.columns, [
      config.personColumn, config.visitColumn, config.visitDetailColumn,
    ])
    return variables
      .map((v) => file.columns!.find((c) => c.id === v.columnId))
      .filter((c): c is DatasetColumn => c != null)
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
