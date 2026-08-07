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
