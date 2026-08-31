import { useMemo } from 'react'
import { useAppStore } from '@/stores/app-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { DataSource } from '@/types'

/**
 * The databases a picker may offer, scoped to one workspace.
 *
 * Every "choose a database" control (ETL source/target, DQ rule set, data
 * catalog, SQL collection, mapping project) filtered the store by `sourceType`
 * alone, so each one listed every workspace's databases and let a user wire an
 * entity to a database from a workspace they were not even in.
 *
 * Returns nothing while the workspace is unknown rather than falling back to the
 * full list: the id resolves a URL prefix through the workspace store, so it is
 * briefly undefined on a cold render, and an unscoped fallback is exactly how the
 * leak looked — a complete list flashing up before the scoped one replaced it.
 *
 * A vocabulary reference is a lookup table, not a database to read from or write
 * to, so it never belongs in these lists.
 *
 * `linkedIds` narrows the list further, to the databases a project has linked.
 * Workspace entities (ETL, DQ, catalog…) pass nothing and see the whole
 * workspace; a project feature (patient board, cohort, concepts) passes the
 * project's links, because "connect a database to a project" is precisely what
 * makes it eligible there. Undefined means "no project scope", which is not the
 * same as an empty array — a project with zero links must offer zero databases.
 */
export function databaseOptions(
  dataSources: DataSource[],
  workspaceId: string | null | undefined,
  linkedIds?: string[],
): DataSource[] {
  if (!workspaceId) return []
  return dataSources.filter(
    (ds) =>
      ds.workspaceId === workspaceId &&
      ds.sourceType === 'database' &&
      !ds.isVocabularyReference &&
      (linkedIds === undefined || linkedIds.includes(ds.id)),
  )
}

export function useDatabaseOptions(
  workspaceId: string | null | undefined,
  projectUid?: string,
): DataSource[] {
  const dataSources = useDataSourceStore((s) => s.dataSources)
  // `_projectsRaw`, not `projects`: the latter is a language-projected view that
  // drops the link list. Subscribing to the raw rows also re-renders the picker
  // when a database is linked or unlinked while it is open.
  const projectsRaw = useAppStore((s) => s._projectsRaw)
  const linkedIds = useMemo(
    () =>
      projectUid
        ? (projectsRaw.find((p) => p.uid === projectUid)?.linkedDataSourceIds ?? [])
        : undefined,
    [projectsRaw, projectUid],
  )
  return useMemo(
    () => databaseOptions(dataSources, workspaceId, linkedIds),
    [dataSources, workspaceId, linkedIds],
  )
}
