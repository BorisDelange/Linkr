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

interface Entry {
  at: number
  tables: Promise<IntrospectedTable[]>
  catalog?: Promise<SqlCatalog>
  /** Set once `tables` resolved: a stale entry keeps serving it while it refreshes. */
  settled?: IntrospectedTable[]
}
const cache = new Map<string, Entry>()

function introspect(dataSourceId: string, previous?: Entry): Entry {
  const entry: Entry = { at: Date.now(), tables: discoverFullSchema(dataSourceId) }
  entry.tables.then(
    (tables) => { entry.settled = tables },
    () => {
      if (cache.get(dataSourceId) !== entry) return
      // A failed refresh keeps the last good schema rather than none.
      if (previous?.settled) cache.set(dataSourceId, { ...previous, at: Date.now() })
      else cache.delete(dataSourceId)
    },
  )
  cache.set(dataSourceId, entry)
  return entry
}

function entryFor(dataSourceId: string): Entry {
  const hit = cache.get(dataSourceId)
  if (!hit) return introspect(dataSourceId)
  if (Date.now() - hit.at < TTL_MS) return hit
  if (!hit.settled) return hit
  // Stale but read: serve it now and refresh behind, so a caller never waits
  // on a full introspection again once the schema was read.
  introspect(dataSourceId, hit)
  return hit
}

/**
 * Every table of a data source with its columns, as the engine introspects it —
 * cached for a minute and shared by the SQL completion and the mapping editor,
 * so neither runs a second full introspection beside the other.
 */
export function loadSourceTables(dataSourceId: string): Promise<IntrospectedTable[]> {
  return entryFor(dataSourceId).tables
}

/** The completion catalog of a data source, cached with its tables. */
export function loadSqlCatalog(dataSourceId: string): Promise<SqlCatalog> {
  const entry = entryFor(dataSourceId)
  entry.catalog ??= entry.tables.then(toSqlCatalog)
  return entry.catalog
}
