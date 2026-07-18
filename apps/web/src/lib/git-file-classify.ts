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
 * Repo-config files Linkr generates but doesn't fully own: the remote copy is
 * often hand-enriched (a .gitignore with .DS_Store / extra embeddings parquet, a
 * hand-tuned .gitattributes). Linkr's export writes a minimal version, so when one
 * already exists (changeType 'modified') committing it would clobber the richer
 * remote copy. We leave those UNCHECKED by default; the user can still tick them
 * to push Linkr's version. When absent remotely (changeType 'added') Linkr's copy
 * is the only one, so it's checked like any new file.
 */
export function isUnownedConfigModification(f: { path: string; changeType: string }): boolean {
  const name = f.path.split('/').pop() ?? f.path
  return (name === '.gitignore' || name === '.gitattributes') && f.changeType === 'modified'
}

/**
 * Paths checked by default in the commit list. Excludes data files (health data
 * isn't pushed by accident), deletions, and modifications to hand-enriched repo
 * config. A "deleted" file is one present on the remote but absent from Linkr's
 * export — often a file created by another tool (the concept-mapping agent's
 * review/, state.json, …). Linkr shouldn't propose to erase or overwrite files it
 * doesn't own without an explicit tick.
 */
export function defaultSelectedPaths(files: { path: string; changeType: string }[]): string[] {
  return files
    .filter((f) => f.changeType !== 'deleted' && !isDataFile(f.path) && !isUnownedConfigModification(f))
    .map((f) => f.path)
}
