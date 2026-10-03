import type { RelationTable } from '@/types/schema-mapping'

/** A table as a database reports it: `table` or `schema.table`, with its columns. */
export interface SourceSchemaTable {
  name: string
  columns: { name: string }[]
}

export interface SourceSchemaIndex {
  /** Every table, schema apart — what the table and schema fields suggest. */
  tables: RelationTable[]
  /** The columns of a table the mapping names, matched case-insensitively. */
  columnsOf: (ref: RelationTable) => string[] | undefined
}

/**
 * The tables and columns a database actually has, for the mapping editor's
 * suggestions. A reference without a schema finds the table in whichever schema
 * holds it, as the search path would.
 */
export function indexSourceSchema(tables: readonly SourceSchemaTable[]): SourceSchemaIndex {
  const byQualified = new Map<string, string[]>()
  const byBare = new Map<string, string[]>()
  const out: RelationTable[] = []
  for (const t of tables) {
    const dot = t.name.lastIndexOf('.')
    const schema = dot > 0 ? t.name.slice(0, dot) : undefined
    const table = dot > 0 ? t.name.slice(dot + 1) : t.name
    const columns = t.columns.map((c) => c.name)
    out.push({ schema, table, alias: '' })
    byQualified.set(`${schema ?? ''}.${table}`.toLowerCase(), columns)
    if (!byBare.has(table.toLowerCase())) byBare.set(table.toLowerCase(), columns)
  }
  return {
    tables: out,
    columnsOf: (ref) => {
      if (!ref.table) return undefined
      if (ref.schema) return byQualified.get(`${ref.schema}.${ref.table}`.toLowerCase())
      return byQualified.get(`.${ref.table}`.toLowerCase()) ?? byBare.get(ref.table.toLowerCase())
    },
  }
}
