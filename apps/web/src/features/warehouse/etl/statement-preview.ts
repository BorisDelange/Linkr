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
 * 1-based line where `statement` starts inside `sql`, or null when not found.
 *
 * Located by searching the text rather than tracked through the splitter: the
 * runner reports the statement it is executing, and the splitter deliberately
 * returns trimmed text with no positions. Matching on the first non-comment line
 * survives that trimming — the raw statement in the file may be preceded by
 * comments and indentation the reported one has lost.
 */
export function statementLine(sql: string, statement: string | undefined): number | null {
  if (!sql || !statement) return null

  // The first line that is actual code: comments before a statement belong to it
  // in the split, so anchoring on them would land above the statement.
  const anchor = statement
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('--'))
  if (!anchor) return null

  const lines = sql.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith(anchor.slice(0, Math.min(anchor.length, 60)))) return i + 1
  }
  return null
}
