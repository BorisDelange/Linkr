import type { DatabaseEngine } from '@/types'

/** Network databases the server reaches by ATTACHing them into DuckDB (server mode
 *  only). Mirrors `EXTERNAL_ENGINES` in `apps/api/app/services/data/db_connect.py`. */
export const EXTERNAL_ENGINES = ['postgresql', 'mysql', 'doris'] as const satisfies readonly DatabaseEngine[]

export function isExternalEngine(engine: unknown): boolean {
  return (EXTERNAL_ENGINES as readonly unknown[]).includes(engine)
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

/** Doris answers the MySQL protocol on its FE query port, not on 3306. */
export const DEFAULT_PORTS: Partial<Record<DatabaseEngine, string>> = {
  postgresql: '5432',
  mysql: '3306',
  doris: '9030',
  sqlserver: '1433',
}
