import type { DatasetFile } from '@/types'

/**
 * Whether a dataset's raw file still represents it.
 *
 * The raw file is the bytes originally uploaded (or written at creation). It stops
 * being the dataset the moment an op is recorded: the edits live in the log, not in
 * those bytes. Downloading the raw file of an edited dataset therefore hands back the
 * PRE-EDIT original — for a collection dataset, the near-empty file created at setup,
 * carrying the identity columns and none of the collected variables.
 *
 * Unedited datasets keep preferring the raw file, so an XLSX or parquet downloads in
 * its own format instead of being flattened to CSV.
 */
export function rawFileRepresentsDataset(file: Pick<DatasetFile, 'ops'>): boolean {
  return (file.ops?.length ?? 0) === 0
}
