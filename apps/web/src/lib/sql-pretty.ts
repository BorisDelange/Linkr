/**
 * SQL laid out for reading — a clause a line, a column a line, indented by
 * nesting. Whitespace only, keywords as written: it still says exactly what
 * ran. The text as it came when the formatter cannot read it (a corner of a
 * dialect), and loaded only once a query is shown.
 */
export async function prettySql(sql: string): Promise<string> {
  try {
    const { format } = await import('sql-formatter')
    return format(sql, { language: 'duckdb', keywordCase: 'preserve', tabWidth: 2, expressionWidth: 60 })
  } catch {
    return sql
  }
}
