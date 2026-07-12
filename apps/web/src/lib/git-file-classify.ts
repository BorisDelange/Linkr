/**
 * Classify an export-tree path as "data" or not, mirroring the export tab's
 * includeDataFiles rule: dataset CSV / parquet / xlsx / xls files and row dumps.
 *
 * Used by the commit UI to leave data files unchecked by default, so health
 * data isn't pushed to git by accident — the same guard the export ZIP applies
 * via its dynamic .gitignore.
 */

const DATA_EXTENSIONS = ['.csv', '.parquet', '.pq', '.xlsx', '.xls']

export function isDataFile(path: string): boolean {
  const p = path.toLowerCase()
  if (!p.startsWith('datasets/')) return false
  // Raw row dumps and tabular data files are the heavy/sensitive payloads.
  if (p.endsWith('/_data.json')) return true
  return DATA_EXTENSIONS.some((ext) => p.endsWith(ext))
}

/**
 * Paths checked by default in the commit list. Excludes data files (health data
 * isn't pushed by accident) AND deletions: a "deleted" file is one present on the
 * remote but absent from Linkr's export — often a file created by another tool
 * (the concept-mapping agent's review/, state.json, …). Linkr shouldn't propose
 * to erase files it doesn't own without an explicit tick.
 */
export function defaultSelectedPaths(files: { path: string; changeType: string }[]): string[] {
  return files.filter((f) => f.changeType !== 'deleted' && !isDataFile(f.path)).map((f) => f.path)
}
