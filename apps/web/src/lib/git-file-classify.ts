/**
 * Classify an export-tree path as "data" or not, mirroring the export tab's
 * includeDataFiles rule: dataset CSV / parquet / xlsx / xls files and row dumps.
 *
 * Used by the commit UI to leave data files unchecked by default, so health
 * data isn't pushed to git by accident — the same guard the export ZIP applies
 * via its dynamic .gitignore.
 */

import { gitFileMeta } from '@/lib/git-file-meta'
import type { GitScope } from '@/lib/api/git'

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

function isConfigFile(path: string): boolean {
  const name = path.split('/').pop() ?? path
  return name === '.gitignore' || name === '.gitattributes'
}

/**
 * Paths checked by default in the commit list. Excludes data files (health data
 * isn't pushed by accident) and modifications to hand-enriched repo config.
 *
 * A "deleted" file is one present on the remote but absent from Linkr's export.
 * When it maps to a KNOWN category (a mapping, dashboard, script, … that Linkr
 * owns) its absence is a genuine deletion, so we check it by default — else the
 * remote keeps a stale copy of a Linkr-managed file the user actually removed.
 * When it falls in the 'other' bucket it's a foreign file another tool created
 * (the concept-mapping agent's review/, state.json, …); Linkr must not propose to
 * erase what it doesn't own, so those stay unchecked.
 */
export function defaultSelectedPaths(
  scope: GitScope,
  files: { path: string; changeType: string }[],
): string[] {
  return files
    .filter((f) => {
      if (isDataFile(f.path) || isUnownedConfigModification(f)) return false
      // A deleted .gitignore/.gitattributes is category 'config' (not 'other'), so
      // don't let the deletion branch below propose to erase a hand-enriched remote
      // copy by default — same reasoning as isUnownedConfigModification.
      if (f.changeType === 'deleted') {
        if (isConfigFile(f.path)) return false
        return gitFileMeta(scope, f.path).category !== 'other'
      }
      return true
    })
    .map((f) => f.path)
}
