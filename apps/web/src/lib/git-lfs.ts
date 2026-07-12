/**
 * Decide which files in an export should be tracked via Git LFS, and render the
 * `.gitattributes` that declares them. A file goes to LFS if its extension is a
 * heavy/binary data format OR its size exceeds a threshold (default 10 MB), so a
 * ~100 MB similarity-scores.parquet or a large CSV never lands as a normal git
 * blob (which would bloat the repo permanently).
 */

export const LFS_SIZE_THRESHOLD = 10 * 1024 * 1024 // 10 MB

const LFS_EXTENSIONS = ['.parquet', '.pq', '.xlsx', '.xls']

export interface ExportEntry {
  path: string
  size: number
}

export function isLfsCandidate(entry: ExportEntry): boolean {
  const p = entry.path.toLowerCase()
  if (LFS_EXTENSIONS.some((ext) => p.endsWith(ext))) return true
  return entry.size > LFS_SIZE_THRESHOLD
}

/**
 * Build `.gitattributes` content for the given LFS paths. A path whose extension
 * is a data format collapses to an extension glob (`*.parquet`) — matching the
 * conventional hand-written form and also covering sibling files of that type;
 * anything else (a large CSV/JSON tracked by size or override) gets an exact
 * per-path rule. Returns null when nothing qualifies.
 */
export function buildGitAttributes(lfsPaths: string[]): string | null {
  if (lfsPaths.length === 0) return null
  const patterns = new Set<string>()
  for (const path of lfsPaths) {
    const ext = LFS_EXTENSIONS.find((e) => path.toLowerCase().endsWith(e))
    patterns.add(ext ? `*${ext}` : quotePattern(path))
  }
  const lines = [...patterns].sort().map((p) => `${p} filter=lfs diff=lfs merge=lfs -text`)
  return lines.join('\n') + '\n'
}

/** gitattributes pattern quoting: wrap paths containing spaces in double quotes. */
function quotePattern(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}

/**
 * Effective LFS paths for a set of changed files: the auto rule (isLfsCandidate)
 * unless the user overrode it. `overrides` maps a path to a forced decision
 * (true = force LFS, false = force normal blob). Returned as a sorted array.
 */
export function resolveLfsPaths(entries: ExportEntry[], overrides: Map<string, boolean>): string[] {
  return entries
    .filter((e) => (overrides.has(e.path) ? overrides.get(e.path)! : isLfsCandidate(e)))
    .map((e) => e.path)
    .sort()
}
