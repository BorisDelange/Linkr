/**
 * Deterministic dataset column ids derived from the column NAME.
 *
 * A column id is the physical key for row data (IndexedDB `_data.json` and the
 * server's Parquet cache). Deriving it deterministically from the name — instead
 * of a volatile `col-<timestamp>-<idx>` — means the same name yields the same id
 * on every parse, on the client AND the server, so export→reimport and
 * fullstack↔client-only stay in lockstep with no id-remapping needed.
 *
 * This MUST stay a faithful twin of the Python port
 * (apps/api/app/services/data/column_id.py). Any change to the slug rules or the
 * collision-suffix scheme must be mirrored there, or client and server ids drift.
 * A shared fixture + parity tests guard this (see column-id.test.ts).
 */

/** Normalize a single name into its slug body (no prefix, no collision handling). */
function slugBody(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '') // strip all combining marks (Unicode category Mn) — matches Python's unicodedata category check
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // punctuation/space runs → single _
    .replace(/^_+|_+$/g, '') // trim leading/trailing _
  return base === '' ? 'col' : base
}

/**
 * Column id for a single name. The `col_` prefix keeps ids readable, guarantees a
 * leading letter (so numeric names like "2024" stay valid identifiers), and marks
 * the deterministic scheme (legacy ids are `col-<digits>`, new ids are `col_<slug>`).
 */
export function columnId(name: string): string {
  return `col_${slugBody(name)}`
}

/**
 * Column ids for an ordered list of names, with deterministic collision suffixes.
 * Two names that normalize to the same slug (e.g. "hospit unit" / "hospit_unit"),
 * or genuine duplicate headers, get `_2`, `_3`, … in header order — identically on
 * the client and server since both iterate headers in file-column order.
 */
export function buildColumnIds(names: string[]): string[] {
  const taken = new Set<string>()
  return names.map((name) => uniqueColumnId(name, taken))
}

/**
 * Column id for `name` unique against an existing set (mutated: the chosen id is
 * added). Used by buildColumnIds and by adding a single column to an existing file.
 */
export function uniqueColumnId(name: string, taken: Set<string>): string {
  const base = columnId(name)
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}_${n++}`
  taken.add(id)
  return id
}
