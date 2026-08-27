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

/**
 * Catalog types with no git scope: installable, never pushed.
 *
 * `database` is the only one, and deliberately: a database repo carries data, and
 * the app never writes a row (`buildDataSourceFolder` publishes metadata only), so
 * that it can never be the path by which patient data leaves a hospital. Installing
 * one runs the other way and is safe. Giving it a scope would put a push button on
 * the one entity that must not have one.
 */
export const INSTALL_ONLY_TYPES: readonly CatalogEntryType[] = ['database']

const BY_SCOPE: Partial<Record<GitScope, CatalogEntryType>> = {
  'workspaces': 'workspace',
  'projects': 'project',
  'mapping-projects': 'mapping-project',
  'sql-script-collections': 'sql-collection',
  'etl-pipelines': 'etl-pipeline',
  'data-catalogs': 'data-catalog',
  'dq-rule-sets': 'dq-rule-set',
  'schema-presets': 'schema-preset',
}

export function catalogTypeForScope(scope: GitScope | undefined): CatalogEntryType | undefined {
  return scope ? BY_SCOPE[scope] : undefined
}
