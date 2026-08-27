import { useMemo } from 'react'
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
 */
export function databaseOptions(
  dataSources: DataSource[],
  workspaceId: string | null | undefined,
): DataSource[] {
  if (!workspaceId) return []
  return dataSources.filter(
    (ds) =>
      ds.workspaceId === workspaceId &&
      ds.sourceType === 'database' &&
      !ds.isVocabularyReference,
  )
}

export function useDatabaseOptions(workspaceId: string | null | undefined): DataSource[] {
  const dataSources = useDataSourceStore((s) => s.dataSources)
  return useMemo(() => databaseOptions(dataSources, workspaceId), [dataSources, workspaceId])
}
