/**
 * The two decisions that keep a front-only query from racing its own mount.
 *
 * They live outside engine.ts so they can be tested without standing up
 * DuckDB-WASM: the engine holds the connection, this holds the rules.
 */

/**
 * Whether queryDataSource should wait for the source to be mounted.
 *
 * `filesrc_<projectId>` ids are a mapping project's CSV, not a data-source row,
 * so there is nothing to mount and asking would throw "not found".
 */
export function shouldGuardMount(dataSourceId: string, hasGuard: boolean): boolean {
  return hasGuard && !dataSourceId.startsWith('filesrc_')
}

/**
 * Whether a remount must DETACH (an attached database) or DROP SCHEMA.
 *
 * `catalogRows` is how many rows the catalog returned for this schema name, or
 * undefined when it could not be read. The catalog wins over `remembered`,
 * which is module memory filled only once a mount succeeds: a mount that failed
 * after its ATTACH leaves a database attached that we no longer track, and
 * DROP SCHEMA does not detach it — the next ATTACH then fails with "database
 * with name ds_… already exists".
 */
export function isAttachedCatalog(
  { remembered, catalogRows }: { remembered: boolean; catalogRows: number | undefined },
): boolean {
  if (catalogRows === undefined) return remembered
  return catalogRows > 0
}
