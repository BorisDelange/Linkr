import type { DatabaseEngine } from '@/types'

/** Network databases the server reaches by ATTACHing them into DuckDB (server mode
 *  only). Mirrors `EXTERNAL_ENGINES` in `apps/api/app/services/data/db_connect.py`. */
export const EXTERNAL_ENGINES = ['postgresql', 'mysql', 'doris'] as const satisfies readonly DatabaseEngine[]

export function isExternalEngine(engine: unknown): boolean {
  return (EXTERNAL_ENGINES as readonly unknown[]).includes(engine)
}

/** Engines that compute Linkr's queries themselves when the server finds them
 *  portable, and take native SQL. Mirrors `PUSHDOWN_ENGINES` in
 *  `apps/api/app/services/data/remote_sql.py`. */
export function computesQueries(engine: unknown): boolean {
  return engine === 'doris'
}

export const ENGINE_LABELS: Record<DatabaseEngine, string> = {
  duckdb: 'DuckDB',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
  mysql: 'MySQL',
  doris: 'Apache Doris',
  sqlserver: 'SQL Server',
  oracle: 'Oracle',
}

/** MySQL and Doris have no level between the server and the schema: what they
 *  call a database is a schema, and one connection reads them all. Their form
 *  has a single field, the default schema, kept under `database` — the key their
 *  DSN already reads, so a database saved before keeps its value and its logins.
 *  The server reads `schema` before `database` for them (`db_connect._scope`). */
export function databaseIsSchema(engine: DatabaseEngine | undefined): boolean {
  return engine === 'mysql' || engine === 'doris'
}

/** Doris answers the MySQL protocol on its FE query port, not on 3306. */
export const DEFAULT_PORTS: Partial<Record<DatabaseEngine, string>> = {
  postgresql: '5432',
  mysql: '3306',
  doris: '9030',
  sqlserver: '1433',
}

/** The port a connection goes to: the one set, else the engine's default (the
 *  server applies the same, `db_connect.port_of`). */
export function portOf(config: { engine?: DatabaseEngine; port?: number | string | null }): string | undefined {
  return config.port ? String(config.port) : config.engine ? DEFAULT_PORTS[config.engine] : undefined
}

/** A TCP port typed in a form, or null when the text is not one (blank included). */
export function parsePort(value: string): number | null {
  const text = value.trim()
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}
