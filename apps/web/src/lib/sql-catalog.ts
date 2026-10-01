import { discoverFullSchema, type IntrospectedTable } from '@/lib/duckdb/engine'
import type { SqlCatalog, SqlCatalogSchema } from '@/lib/sql-completion'

/**
 * Groups introspected tables (`person`, `hosp.patients`) by schema. Every schema
 * counts as reachable unqualified: both the client and the server put all of a
 * source's schemas on the search path.
 */
export function toSqlCatalog(tables: IntrospectedTable[]): SqlCatalog {
  const bySchema = new Map<string, SqlCatalogSchema>()
  for (const t of tables) {
    const dot = t.name.indexOf('.')
    const schema = dot === -1 ? 'main' : t.name.slice(0, dot)
    const name = dot === -1 ? t.name : t.name.slice(dot + 1)
    if (!bySchema.has(schema)) bySchema.set(schema, { name: schema, tables: [] })
    bySchema.get(schema)!.tables.push({ name, columns: t.columns.map((c) => ({ name: c.name, type: c.type })) })
  }
  const schemas = [...bySchema.values()]
  return { schemas, defaultSchemas: schemas.map((s) => s.name) }
}

// A schema rarely changes while an editor is open, and introspection is a round
// trip per keystroke otherwise. Kept short so a table created from the SQL tab
// shows up without a reload.
const TTL_MS = 60_000
const cache = new Map<string, { at: number; catalog: Promise<SqlCatalog> }>()

/** The completion catalog of a data source, cached for a minute. */
export function loadSqlCatalog(dataSourceId: string): Promise<SqlCatalog> {
  const hit = cache.get(dataSourceId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.catalog
  const catalog = discoverFullSchema(dataSourceId).then(toSqlCatalog)
  cache.set(dataSourceId, { at: Date.now(), catalog })
  catalog.catch(() => cache.delete(dataSourceId))
  return catalog
}
