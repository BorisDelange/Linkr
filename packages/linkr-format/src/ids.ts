/**
 * Id and key derivation, mirroring the app.
 *
 * These are faithful twins of `apps/web/src/lib/column-id.ts` and the `slugify`
 * in `apps/web/src/lib/entity-io.ts`. They are duplicated here on purpose and
 * only until step 4 of docs/planning/mcp-authoring-plan.md, which makes the app
 * import them from this package instead — at which point these become the single
 * definition and the app-side copies are deleted.
 *
 * Parity is not cosmetic: `columnId` already has a Python twin
 * (apps/api/app/services/data/column_id.py) guarded by a shared fixture, because
 * a drift between the two silently orphans every filter and widget config that
 * points at a column. A third copy that drifts would do the same, so
 * `ids.parity.test.ts` re-runs the app's own fixture against these functions.
 */

/** Column id slug body — no prefix, no collision handling. */
function slugBody(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return base === '' ? 'col' : base
}

/** Deterministic column id derived from the column NAME: `col_<slug>`. */
export function columnId(name: string): string {
  return `col_${slugBody(name)}`
}

/** Column ids for ordered names, with `_2`, `_3`… suffixes on collision. */
export function buildColumnIds(names: string[]): string[] {
  const taken = new Set<string>()
  return names.map((name) => {
    const base = columnId(name)
    let id = base
    let n = 2
    while (taken.has(id)) id = `${base}_${n++}`
    taken.add(id)
    return id
  })
}

/** Path/filename slug, `-`-separated. Used for dashboard filenames and content keys.
 *
 *  Strips by Unicode category (`Mn`), not by the Combining Diacritical Marks
 *  block: the Python twin uses `unicodedata.combining`, which covers every mark,
 *  so the narrower range disagreed on ~500 code points (Cyrillic titlo, Hebrew
 *  points\u2026). Same rule the column-id slug already uses. */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/\p{Mn}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'export'
  )
}

/** A legacy, non-deterministic column id: `col-0`, `col-1748…`. */
export function isLegacyColumnId(id: string): boolean {
  return /^col-\d+$/.test(id)
}
