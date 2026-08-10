/**
 * First name in the "Foo", "Foo (2)", "Foo (3)"… series that is not taken.
 *
 * Used when an action re-creates something from an existing template: the base
 * name would collide with the copy already there, and a form that rejects its
 * own prefilled value is a dead end for the user.
 *
 * Comparison is case-insensitive and trims surrounding blanks, matching how the
 * duplicate checks in the UI compare names.
 */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const norm = (s: string) => s.trim().toLowerCase()
  const used = new Set([...taken].map(norm))
  if (!used.has(norm(base))) return base

  // Start at 2: the untouched base name is conceptually the first one.
  for (let n = 2; ; n++) {
    const candidate = `${base.trim()} (${n})`
    if (!used.has(norm(candidate))) return candidate
  }
}

/**
 * First free FILENAME in the "a.sql", "a-2.sql", "a-3.sql"… series.
 *
 * Distinct from `uniqueName` above: that one appends " (2)" for display names,
 * this one inserts the counter before the EXTENSION, which is what a file tree
 * needs. Case-insensitive, because two files differing only in case are the same
 * file to git on macOS and Windows and the export tree could not hold both.
 *
 * Re-exported from the ETL module, which owns the implementation and its tests,
 * so every file tree shares one rule instead of hand-rolling its own.
 */
export { uniqueEtlFileName as uniqueFileName } from '@/features/warehouse/etl/etl-file-language'
