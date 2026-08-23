/**
 * Map a git sync scope to the catalog entry type that publishes the same entity.
 *
 * The import dialog is opened from a page that knows its `GitScope`, while the catalog
 * indexes by `CatalogEntryType`. The two vocabularies name the same seven entities with
 * different words (plural route-ish slugs vs singular type names), so the crossing has
 * to happen somewhere; keeping it here means neither side has to learn the other's.
 *
 * Scopes with no catalog counterpart (`workspaces`, `user-plugins`, `settings`) map to
 * undefined, and their dialog simply shows no catalog tab.
 */
import type { GitScope } from '@/lib/api/git'
import type { CatalogEntryType } from './types'

const BY_SCOPE: Partial<Record<GitScope, CatalogEntryType>> = {
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
