/**
 * One place that knows what parts of a SQL string are NOT executable structure:
 * string literals, quoted identifiers, comments and dollar-quoted blocks. Both
 * the statement splitter and the role-prefix rewriter must agree on this, or a
 * `;` inside a block comment splits a statement in two, or a `source.` inside a
 * `$$...$$` body gets rewritten. They used to disagree; now they share this.
 */

/** A half-open span `[start, end)` of the SQL that must be treated as opaque. */
export interface Region {
  start: number
  end: number
}

/**
 * Scan `sql` and return every protected region, in order. Handles:
 *  - line comments (`-- ...`)
 *  - block comments (slash-star to star-slash)
 *  - `'single'`, `"double"`, `` `backtick` `` runs — a doubled quote escapes it,
 *    and a backslash escapes the next char inside a single-quoted run (DuckDB's
 *    `E'...\'...'`), so an escaped quote does not end the literal early
 *  - `$tag$ ... $tag$` dollar-quoted blocks (the tag may be empty: `$$...$$`)
 *
 * An unterminated region runs to end-of-input rather than being dropped, so the
 * remainder of the script is never silently treated as executable structure.
 */
export function protectedRegions(sql: string): Region[] {
  const regions: Region[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]

    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      regions.push({ start: i, end: stop })
      i = stop
      continue
    }

    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      regions.push({ start: i, end: stop })
      i = stop
      continue
    }

    if (ch === '$') {
      const tag = matchDollarTag(sql, i)
      if (tag !== null) {
        const close = sql.indexOf(tag, i + tag.length)
        const stop = close === -1 ? sql.length : close + tag.length
        regions.push({ start: i, end: stop })
        i = stop
        continue
      }
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < sql.length) {
        // Backslash escapes the next char inside a single-quoted run.
        if (ch === "'" && sql[j] === '\\' && j + 1 < sql.length) {
          j += 2
          continue
        }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      const stop = j >= sql.length ? sql.length : j + 1
      regions.push({ start: i, end: stop })
      i = stop
      continue
    }

    i++
  }
  return regions
}

/** Whether `index` falls inside any protected region. */
export function isProtected(regions: Region[], index: number): boolean {
  return regions.some((r) => index >= r.start && index < r.end)
}

/**
 * If a dollar-quote tag opens at `at` (`$$` or `$name$`), return the tag string
 * (e.g. `"$$"`, `"$body$"`); otherwise null. A tag is `$` + optional identifier
 * + `$`, where the identifier starts with a letter/underscore.
 */
function matchDollarTag(sql: string, at: number): string | null {
  if (sql[at] !== '$') return null
  let j = at + 1
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) {
    // The first char of a non-empty tag must not be a digit.
    if (j === at + 1 && /[0-9]/.test(sql[j])) return null
    j++
  }
  if (sql[j] === '$') return sql.slice(at, j + 1)
  return null
}

/**
 * Split a SQL script into individual statements on top-level semicolons —
 * those not inside a string, comment or dollar-quoted block.
 */
export function splitSqlStatements(sql: string): string[] {
  const regions = protectedRegions(sql)
  const stmts: string[] = []
  let start = 0
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] !== ';' || isProtected(regions, i)) continue
    const stmt = sql.slice(start, i).trim()
    if (stmt) stmts.push(stmt)
    start = i + 1
  }
  const tail = sql.slice(start).trim()
  if (tail) stmts.push(tail)
  return stmts
}
