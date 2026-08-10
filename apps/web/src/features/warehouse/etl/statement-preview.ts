import { isProtected, protectedRegions, type Region } from '@/lib/duckdb/sql-tokenizer'

/**
 * Rank of the statement currently running, 1-based.
 *
 * `statementsDone` counts the ones that FINISHED, so while statement 2 is in
 * flight it holds 1 — the counter read "query 1/26" while its own tooltip showed
 * statement 2. Naming the statement being waited on matches the tooltip, and is
 * what "query n/m" is taken to mean.
 *
 * Once nothing is pending (`currentStatement` cleared) the count is already
 * final: adding one would overshoot the total on the last report.
 */
export function currentStatementNumber(log: {
  statementsDone?: number
  statementsTotal?: number
  currentStatement?: string
}): number {
  const done = log.statementsDone ?? 0
  const total = log.statementsTotal ?? 0
  if (!log.currentStatement) return Math.min(done, total)
  return Math.min(done + 1, total)
}

/**
 * Opening of the statement being waited on, for the counter's tooltip. Comments
 * are dropped and whitespace collapsed: a generated script often starts a
 * statement with several comment lines, which would fill the tooltip with nothing.
 */
export function statementPreview(sql: string | undefined, max = 220): string | null {
  if (!sql) return null
  const code = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!code) return null
  return code.length > max ? `${code.slice(0, max)}…` : code
}

/**
 * Tooltip body for the progress counter: `Line 151: TRUNCATE …`.
 *
 * The line is omitted rather than guessed when it cannot be resolved (no script
 * text yet, or an index past its end), so the tooltip never claims a position
 * the jump would not honour.
 */
export function statementTooltip(
  sql: string | undefined,
  index: number | undefined,
  statement: string | undefined,
): string | null {
  const preview = statementPreview(statement)
  if (!preview) return null
  const line = sql ? statementLineAt(sql, index) : null
  return line == null ? preview : `Line ${line}: ${preview}`
}

/**
 * 1-based line where the statement at `index` (0-based) starts inside `sql`.
 *
 * Resolved by POSITION, not by text. Searching for the statement's opening line
 * looked equivalent but silently picked the wrong one: a generated vocabulary
 * script has four statements starting `INSERT INTO "target".concept` and ten
 * starting `TRUNCATE "target".<table>`, so every match landed on the first
 * lookalike — "Query 10/26" jumped to the line of query 3.
 *
 * The index is authoritative because the runner splits with the same tokenizer
 * and reports the loop index, and because role resolution rewrites statements
 * in place without adding or removing any.
 *
 * The line returned is the statement's first line of actual CODE: leading
 * comments belong to the statement in the split, so returning its raw start
 * would land above it, on a comment block that can be several lines long.
 */
export function statementLineAt(sql: string, index: number | undefined): number | null {
  if (!sql || index == null || index < 0) return null

  const regions = protectedRegions(sql)
  let start = 0
  let n = 0
  for (let i = 0; i <= sql.length; i++) {
    const atEnd = i === sql.length
    if (!atEnd && (sql[i] !== ';' || isProtected(regions, i))) continue
    const slice = sql.slice(start, atEnd ? sql.length : i)
    if (slice.trim()) {
      if (n === index) return firstCodeLine(sql, start, slice, regions)
      n++
    }
    start = i + 1
  }
  return null
}

/**
 * 1-based line of the first line carrying actual code in the statement that
 * occupies `[start, start + slice.length)`.
 *
 * Comment lines are skipped using the tokenizer's regions rather than a
 * `startsWith('--')` test, so a `/* ... *&#47;` block between two statements is
 * skipped as well — it belongs to the following statement in the split, and
 * stopping on it reported a line whose text was not the statement at all.
 */
function firstCodeLine(sql: string, start: number, slice: string, regions: Region[]): number {
  const base = sql.slice(0, start).split('\n').length
  let offset = start
  const lines = slice.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    // The first non-blank character decides: if it is inside a comment region,
    // the whole line is commentary and the statement's code is further down.
    if (trimmed && !isProtected(regions, offset + lines[i].indexOf(trimmed[0]))) return base + i
    offset += lines[i].length + 1
  }
  return base
}
