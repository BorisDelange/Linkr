import type { DatabaseConnectionConfig, DataSource } from '@/types'

/** A rebuildable database is one Linkr built as an empty DuckDB from a DDL, that
 *  is not working and still holds that DDL. Never a database Linkr only connects
 *  to (Postgres, Oracle, a user's own file…): its schema mapping carries a DDL
 *  too, and a rebuild would swap it for an empty file. Not while it is being set
 *  up: a derivation job may be writing that file. */
export function canRebuild(source: DataSource): boolean {
  const config = source.connectionConfig as DatabaseConnectionConfig | undefined
  const builtByLinkr = config?.engine === 'duckdb' && (!!config.managed || !!config.inMemory)
  return builtByLinkr && source.status !== 'connected' && source.status !== 'configuring' && !!source.schemaMapping?.ddl
}

/**
 * Whether the banner shows: any non-working state that carries a reason, not
 * just 'error' — a database left disconnected by a data-free import has
 * something to say too. Not gated on `errorMessage` alone: a database imported
 * before the import recorded a reason is disconnected and silent, and gating on
 * the message made the rebuild — the only action that can fix it — unreachable.
 */
export function connectionBannerShown(source: DataSource): boolean {
  return source.status !== 'connected' && (source.status === 'configuring' || !!source.errorMessage || canRebuild(source))
}
