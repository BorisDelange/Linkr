/**
 * Tiny reactive store for files in the shared virtual filesystem.
 * Updated by the onSharedFilesChanged callback from shared-fs.ts.
 *
 * When new files appear (e.g. a script writes a CSV), they are automatically
 * persisted to the dataset-store so they survive page reloads.
 */
import { create } from 'zustand'
import { onSharedFilesChanged } from '@/lib/runtimes/shared-fs'
import { useDatasetStore } from '@/stores/dataset-store'
import type { DatasetColumn } from '@/types'

interface SharedFsState {
  /** File names in data/datasets/ (e.g. ["data/datasets/mortality_dataset.csv"]) */
  fileNames: string[]
}

export const useSharedFsStore = create<SharedFsState>()(() => ({
  fileNames: [],
}))

/** Simple CSV parser: returns { headers, rows } from raw text. */
function parseCsv(text: string, delimiter = ','): { headers: string[]; rows: Record<string, unknown>[] } {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ''))
  const rows: Record<string, unknown>[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ''))
    const row: Record<string, unknown> = {}
    for (let j = 0; j < headers.length; j++) {
      const val = cells[j] ?? ''
      // Try to parse as number
      const num = Number(val)
      row[`col-${j}`] = val === '' ? null : !isNaN(num) && val !== '' ? num : val
    }
    rows.push(row)
  }
  return { headers, rows }
}

/** Infer column type from values. */
function inferType(values: unknown[]): DatasetColumn['type'] {
  let hasNumber = false
  let hasString = false
  for (const v of values) {
    if (v === null || v === undefined) continue
    if (typeof v === 'number') hasNumber = true
    else hasString = true
  }
  if (hasString) return 'string'
  if (hasNumber) return 'number'
  return 'string'
}

// Subscribe to shared-fs changes and update the store + persist to dataset-store
onSharedFilesChanged((files) => {
  useSharedFsStore.setState({ fileNames: Array.from(files.keys()) })

  // Persist each file to the dataset-store
  const ds = useDatasetStore.getState()
  if (!ds.activeProjectUid) return

  for (const [fullPath, bytes] of files) {
    const fileName = fullPath.substring(fullPath.lastIndexOf('/') + 1)
    const ext = fileName.split('.').pop()?.toLowerCase()

    // Only auto-import CSV/TSV files
    if (ext !== 'csv' && ext !== 'tsv') continue

    const text = new TextDecoder().decode(bytes)
    const delimiter = ext === 'tsv' ? '\t' : ','
    const { headers, rows } = parseCsv(text, delimiter)
    if (headers.length === 0) continue

    const columns: DatasetColumn[] = headers.map((h, i) => ({
      id: `col-${i}`,
      name: h,
      type: inferType(rows.slice(0, 100).map((r) => r[`col-${i}`])),
      order: i,
    }))

    // Check if this file already exists in the dataset-store
    const existing = ds.files.find((f) => f.name === fileName && f.parentId === null)
    if (existing) {
      // Update existing file with new data
      ds.importData(existing.id, columns, rows)
    } else {
      // Create new dataset file then import data
      ds.createFile(fileName, null)
      // Get the freshly created file
      const freshState = useDatasetStore.getState()
      const created = freshState.files.find((f) => f.name === fileName && f.parentId === null)
      if (created) {
        freshState.importData(created.id, columns, rows)
      }
    }
  }
})
