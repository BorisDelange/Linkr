/**
 * Decide which files in an export are tracked via Git LFS, and render the
 * `.gitattributes` that declares them. LFS is never applied automatically (no
 * size threshold, no extension rule): re-derivable heavy files (e.g. a
 * similarity-scores.parquet) are gitignored rather than versioned, and any file
 * a user genuinely wants in LFS is opted in by hand via the per-file toggle
 * (context menu / badge in the versioning panel). This keeps text files like
 * mappings.json as normal git blobs so they stay diffable.
 */

export interface ExportEntry {
  path: string
  size: number
}

/**
 * Build `.gitattributes` content for the given LFS paths. A path whose extension
 * is a data format collapses to an extension glob (`*.parquet`) — matching the
 * conventional hand-written form and also covering sibling files of that type;
 * anything else gets an exact per-path rule. Returns null when nothing qualifies.
 */
const GLOB_EXTENSIONS = ['.parquet', '.pq', '.xlsx', '.xls']

export function buildGitAttributes(lfsPaths: string[]): string | null {
  if (lfsPaths.length === 0) return null
  const patterns = new Set<string>()
  for (const path of lfsPaths) {
    const ext = GLOB_EXTENSIONS.find((e) => path.toLowerCase().endsWith(e))
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
 * Effective LFS paths for a set of changed files: purely the user's per-file
 * overrides — there is no automatic rule. `overrides` maps a path to a forced
 * decision (true = track via LFS, false = normal blob). Returned as a sorted
 * array; a `false`/absent override means the file is a normal git blob.
 */
export function resolveLfsPaths(entries: ExportEntry[], overrides: Map<string, boolean>): string[] {
  return entries
    .filter((e) => overrides.get(e.path) === true)
    .map((e) => e.path)
    .sort()
}
