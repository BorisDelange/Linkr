import type { DataSource } from '@/types'

/** A rebuildable database is one that is not working and still holds the DDL it
 *  was built from. Not while it is being set up: a derivation job may be writing
 *  that file. */
export function canRebuild(source: DataSource): boolean {
  return source.status !== 'connected' && source.status !== 'configuring' && !!source.schemaMapping?.ddl
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
