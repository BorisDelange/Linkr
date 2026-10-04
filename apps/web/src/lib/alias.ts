import { foldAccents } from '@/lib/fold-accents'

/**
 * Generate a DuckDB-safe alias (slug) from a human-readable name.
 * E.g. "MIMIC-IV Demo (raw)" → "mimic_iv_demo_raw"
 */
export function generateAlias(name: string): string {
  return foldAccents(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'db'
}

/**
 * What two aliases are compared by: the catalog a database is mounted as
 * (`ds_` + the alias with every non-alphanumeric as `_`, see `schemaName`), and
 * DuckDB ignores case — so `My-DB` and `my_db` are one catalog. Twin of the
 * server's `alias_key`.
 */
export function aliasKey(alias: string): string {
  return alias.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
}

/** Whether `alias` would mount as the same catalog as one of `existingAliases`. */
export function isAliasTaken(alias: string, existingAliases: string[]): boolean {
  const key = aliasKey(alias)
  return existingAliases.some((a) => aliasKey(a) === key)
}

/**
 * Ensure alias is unique among existing aliases by appending _2, _3, etc.
 */
export function ensureUniqueAlias(alias: string, existingAliases: string[]): string {
  if (!isAliasTaken(alias, existingAliases)) return alias
  let i = 2
  while (isAliasTaken(`${alias}_${i}`, existingAliases)) i++
  return `${alias}_${i}`
}

/**
 * The aliases a database of `workspaceId` must not reuse. In server mode a script
 * finds a database by alias within its project's workspace (`linkr.connect`), so
 * the workspace is the scope — the same database installed in two workspaces
 * keeps its alias, and scripts stay portable. Client-only mode mounts every
 * database in one browser DuckDB as `ds_<alias>`, so there it is the instance.
 */
export function aliasesInScope(
  sources: { id: string; alias?: string; workspaceId?: string }[],
  workspaceId: string | undefined,
  { instanceWide, exceptId }: { instanceWide: boolean; exceptId?: string },
): string[] {
  return sources
    .filter((ds) => ds.id !== exceptId && (instanceWide || ds.workspaceId === workspaceId))
    .map((ds) => ds.alias)
    .filter((a): a is string => !!a)
}
