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
 *
 * The `projects` scope is the exception: a project's .gitignore is regenerated from
 * the per-file versioning marks (and .gitattributes from the per-file LFS choices),
 * so Linkr fully owns them — a modification IS the user's mark change and must be
 * checked by default, else toggling a file's versioning wouldn't reach the remote.
 */
export function isUnownedConfigModification(
  f: { path: string; changeType: string },
  scope?: GitScope,
): boolean {
  if (scope === 'projects') return false
  const name = f.path.split('/').pop() ?? f.path
  return (name === '.gitignore' || name === '.gitattributes') && f.changeType === 'modified'
}

function isConfigFile(path: string): boolean {
  const name = path.split('/').pop() ?? path
  return name === '.gitignore' || name === '.gitattributes'
}

/**
 * A path Linkr didn't generate and doesn't manage — a file another tool wrote into
 * the repo (the concept-mapping agent's `review/`, `state.json`, a hand-added CSV).
 * These are the ONLY files "Sync all" and the default selection leave aside, so the
 * user versions them deliberately from Details rather than sweeping them in.
 *
 * It is NOT simply "category === 'other'": `.gitignore` / `.gitattributes` are
 * Linkr-managed even in scopes without an explicit rule for them (they fall to
 * 'other' but are ours), so they are never foreign.
 */
export function isForeignPath(scope: GitScope, path: string): boolean {
  if (isConfigFile(path)) return false
  return gitFileMeta(scope, path).category === 'other'
}

/**
 * Paths checked by default in the commit list, and modifications to hand-enriched
 * repo config are left unchecked.
 *
 * Data files are NO LONGER excluded here: a data file only reaches the export tree
 * (and thus this status list) when the user explicitly marked it for versioning
 * (project.config.versionedDataFiles). So its presence IS the consent — check it by
 * default like any other file. Unmarked data never enters the export, so it can't
 * appear here. (isDataFile stays exported for callers that still classify paths.)
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
      if (isUnownedConfigModification(f, scope)) return false
      // A deleted config file (.gitignore/.gitattributes) is left unchecked: Linkr
      // never drops these from an export, so a deletion came from elsewhere and
      // checking it would propose erasing a possibly hand-enriched remote copy.
      // A deletion of a foreign file is likewise left aside (Linkr doesn't own it).
      if (f.changeType === 'deleted') {
        if (isConfigFile(f.path)) return false
        return !isForeignPath(scope, f.path)
      }
      return true
    })
    .map((f) => f.path)
}
