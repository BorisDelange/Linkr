/**
 * Laying out generated SQL: it is read, and hand-edited, in the SQL tabs and
 * dialogs, so a subquery sits indented under what opens it, one condition per
 * line, one id per line.
 */
import { protectedRegions } from './sql-tokenizer'

export const INDENT = '  '

/**
 * Every non-empty line pushed right by `by` — except a line that continues a
 * string literal or a quoted name, whose content the padding would change (a
 * hand-written relation may hold one). A comment's lines are padded like code.
 */
export function indent(sql: string, by = INDENT, skipFirst = false): string {
  const literals = protectedRegions(sql).filter((r) => sql[r.start] !== '-' && sql[r.start] !== '/')
  const inLiteral = (i: number) => literals.some((r) => i > r.start && i < r.end)
  let out = ''
  let lineStart = !skipFirst
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (lineStart && ch !== '\n' && !inLiteral(i)) out += by
    lineStart = ch === '\n'
    out += ch
  }
  return out
}

/** Every line but the first pushed right: a multi-line operand after a keyword. */
export function hang(sql: string, by = INDENT): string {
  return indent(sql, by, true)
}

/**
 * A label as a `--` comment. Line breaks are dropped: the label can be the
 * user's (a concept name, a group label) and a line break would end the comment
 * and let the rest of it run as SQL.
 */
export function sqlComment(label: string): string {
  return `-- ${label.replace(/[\r\n\u0085\u2028\u2029\0]+/g, ' ').trim()}`
}

/**
 * `(…)` around a list of ids, one per line, each followed by what it is when
 * `label` knows (`3014315, -- LOINC - Urine output`), the comments aligned. Ids
 * only: they are validated integers, never quoted.
 */
export function idListSql(ids: readonly (number | string)[], label?: (id: number) => string | undefined): string {
  const items = ids.map((id, i) => `${id}${i < ids.length - 1 ? ',' : ''}`)
  const width = Math.max(...items.map((s) => s.length))
  const lines = ids.map((id, i) => {
    const note = label?.(Number(id))?.trim()
    return note ? `${items[i].padEnd(width)} ${sqlComment(note)}` : items[i]
  })
  return `(\n${indent(lines.join('\n'))}\n)`
}

/** A subquery in place of a table: its body indented under `(`, the `)` back at
 *  the indentation of the line it opens on. */
export function subquerySql(body: string, lineIndent = ''): string {
  return `(\n${indent(body.replace(/^\n+|\s+$/g, ''), lineIndent + INDENT)}\n${lineIndent})`
}
