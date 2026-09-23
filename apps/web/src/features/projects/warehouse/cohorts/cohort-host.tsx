import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useMyProjectRole, useMyWorkspaceRole } from '@/hooks/use-context-role'
import { paths } from '@/lib/paths'
import { shortenIdAmong } from '@/lib/short-id'
import type { SortScope } from '@/lib/use-persisted-sort'
import { useDataSourceStore, useProjectSource } from '@/stores/data-source-store'
import type { Cohort, DataSource } from '@/types'

/**
 * Where the cohort pages are hosted: a project's Cohorts page, or a database's
 * Cohorts tab. The builder, the SQL and the results are the same on both; what
 * differs is who owns the cohort, which database it runs on, which permission
 * gates it and where its links go — and that is all this context carries.
 */
export interface CohortHost {
  kind: 'project' | 'database'
  workspaceId: string | undefined
  /** The owner fields a new cohort is created with. */
  owner: Pick<Cohort, 'projectUid' | 'ownerDataSourceId'>
  owns: (cohort: Cohort) => boolean
  /** `cohorts:*` names the project permission; a database maps it onto its own. */
  can: (permission: 'cohorts:write' | 'cohorts:delete') => boolean
  cohortPath: (cohortId: string, siblingIds: readonly string[]) => string
  listPath: string
  /** Persisted-sort key of the list page. */
  sortKey: SortScope
}

const CohortHostContext = createContext<CohortHost | null>(null)

export function useCohortHost(): CohortHost {
  const host = useContext(CohortHostContext)
  if (!host) throw new Error('useCohortHost outside a cohort host')
  return host
}

/**
 * The database a cohort runs against. A project cohort resolves among the
 * project's linked, connected databases (fallback included); a database's own
 * cohort only ever runs on that database, once it is connected.
 */
export function useCohortSource(cohort: Cohort | undefined): DataSource | undefined {
  const host = useCohortHost()
  const projectSource = useProjectSource(host.owner.projectUid, cohort?.dataSourceId)
  const dataSources = useDataSourceStore((s) => s.dataSources)
  if (host.kind === 'project') return projectSource
  const own = dataSources.find((ds) => ds.id === host.owner.ownerDataSourceId)
  return own?.status === 'connected' ? own : undefined
}

export function ProjectCohortHost({ children }: { children: ReactNode }) {
  const { projectUid, wsUid } = useResolvedParams()
  const { can } = useMyProjectRole(projectUid)
  const host = useMemo<CohortHost>(() => ({
    kind: 'project',
    workspaceId: wsUid,
    owner: { projectUid },
    owns: (c) => !!projectUid && c.projectUid === projectUid,
    can,
    // Built through `paths`: useResolvedParams returns FULL uids, so a
    // hand-assembled URL carried full ids while the sidebar matches on the
    // shortened ones — which silently dropped the Cohorts highlight.
    cohortPath: (id, siblings) => paths.cohort(wsUid ?? '', projectUid ?? '', id, siblings),
    listPath: paths.cohorts(wsUid ?? '', projectUid ?? ''),
    sortKey: 'project-cohorts',
  }), [projectUid, wsUid, can])
  return <CohortHostContext.Provider value={host}>{children}</CohortHostContext.Provider>
}

// A database's cohorts are part of the database: editing one is editing it.
const DATABASE_PERMISSION = {
  'cohorts:write': 'databases:write',
  'cohorts:delete': 'databases:write',
} as const

export function DatabaseCohortHost({
  dataSourceId,
  siblingDatabaseIds,
  children,
}: {
  dataSourceId: string
  /** The workspace's database ids, so the links shorten the database id the
   *  same way the database list does. */
  siblingDatabaseIds: readonly string[]
  children: ReactNode
}) {
  const { wsUid } = useResolvedParams()
  const { can: canWorkspace } = useMyWorkspaceRole(wsUid)
  const host = useMemo<CohortHost>(() => {
    const databasePath = paths.warehouseDatabase(wsUid ?? '', dataSourceId, siblingDatabaseIds)
    return {
      kind: 'database',
      workspaceId: wsUid,
      owner: { ownerDataSourceId: dataSourceId },
      owns: (c) => c.ownerDataSourceId === dataSourceId,
      can: (permission) => canWorkspace(DATABASE_PERMISSION[permission]),
      cohortPath: (id, siblings) => `${databasePath}/cohorts/${shortenIdAmong(id, siblings)}`,
      listPath: `${databasePath}?tab=cohorts`,
      sortKey: 'database-cohorts',
    }
  }, [dataSourceId, siblingDatabaseIds, wsUid, canWorkspace])
  return <CohortHostContext.Provider value={host}>{children}</CohortHostContext.Provider>
}
