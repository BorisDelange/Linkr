/**
 * Token kinds for colouring the report's SQL. Shared by the HTML (spans) and the
 * Word file (coloured runs), so the two print the query the same way — the
 * report is a static file, it cannot ship the app's editor.
 */
export type SqlTokenKind = 'keyword' | 'string' | 'identifier' | 'number' | 'comment' | 'plain'

export interface SqlToken {
  kind: SqlTokenKind
  text: string
}

const KEYWORDS = new Set([
  'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'AS', 'ON',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'GROUP', 'BY', 'ORDER', 'HAVING',
  'LIMIT', 'OFFSET', 'UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'WITH', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'END', 'EXISTS', 'BETWEEN', 'LIKE', 'ILIKE', 'CAST', 'INTERVAL', 'ASC', 'DESC',
  'TRUE', 'FALSE', 'COUNT', 'MIN', 'MAX', 'SUM', 'AVG', 'COALESCE', 'EXTRACT', 'DATE',
  'TIMESTAMP', 'INTEGER', 'BIGINT', 'VARCHAR', 'TEXT', 'DOUBLE', 'OVER', 'PARTITION',
])

// One alternative per kind, tried left to right at each position: comments and
// strings first, so a keyword inside them is not coloured as one.
const TOKEN = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g

export function tokenizeSql(sql: string): SqlToken[] {
  const out: SqlToken[] = []
  let last = 0
  const push = (kind: SqlTokenKind, text: string) => {
    const prev = out[out.length - 1]
    if (prev && prev.kind === kind && kind === 'plain') prev.text += text
    else out.push({ kind, text })
  }
  for (const m of sql.matchAll(TOKEN)) {
    const at = m.index ?? 0
    if (at > last) push('plain', sql.slice(last, at))
    const [text, comment, str, ident, number, word] = m
    if (comment) push('comment', text)
    else if (str) push('string', text)
    else if (ident) push('identifier', text)
    else if (number) push('number', text)
    else if (word) push(KEYWORDS.has(word.toUpperCase()) ? 'keyword' : 'plain', text)
    last = at + text.length
  }
  if (last < sql.length) push('plain', sql.slice(last))
  return out
}

/** Colours per kind, for the print-friendly white background of the report. */
export const SQL_COLORS: Record<Exclude<SqlTokenKind, 'plain'>, string> = {
  keyword: '#0550ae',
  string: '#0a7d32',
  identifier: '#8250df',
  number: '#b35900',
  comment: '#6e7781',
}
