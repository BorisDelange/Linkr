/**
 * Map a git sync scope to the catalog entry type that publishes the same entity.
 *
 * The import dialog is opened from a page that knows its `GitScope`, while the catalog
 * indexes by `CatalogEntryType`. The two vocabularies name the same entities with
 * different words (plural route-ish slugs vs singular type names), so the crossing has
 * to happen somewhere; keeping it here means neither side has to learn the other's.
 *
 * Scopes with no catalog counterpart (`user-plugins`, `settings`) map to undefined, and
 * their dialog simply shows no catalog tab.
 */
import type { GitScope } from '@/lib/api/git'
import type { CatalogEntryType } from './types'

/** Catalog types installable but never pushed. Empty since databases gained a
 *  push panel — one that still publishes metadata only, so the guarantee that
 *  the app is never the path patient data leaves by rests on the export tree
 *  (`buildDataSourceFolder`), not on withholding the scope. */
export const INSTALL_ONLY_TYPES: readonly CatalogEntryType[] = []

const BY_SCOPE: Partial<Record<GitScope, CatalogEntryType>> = {
  'workspaces': 'workspace',
  'projects': 'project',
  'mapping-projects': 'mapping-project',
  'sql-script-collections': 'sql-collection',
  'etl-pipelines': 'etl-pipeline',
  'data-catalogs': 'data-catalog',
  'dq-rule-sets': 'dq-rule-set',
  'schema-presets': 'schema-preset',
  'databases': 'database',
}

export function catalogTypeForScope(scope: GitScope | undefined): CatalogEntryType | undefined {
  return scope ? BY_SCOPE[scope] : undefined
}
