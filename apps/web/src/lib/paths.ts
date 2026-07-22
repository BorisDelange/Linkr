/**
 * Central builders for in-app route paths. The single place that knows the URL shape, so entity
 * ids can be shortened (git-style, see short-id.ts) consistently — instead of 25+ inline
 * template strings each repeating the structure. Full ids still resolve (a prefix of themselves),
 * so links built before this helper keep working.
 *
 * Shortening is sibling-aware: the prefix grows just enough to stay unique among the same-type
 * entities (so the seed's sequential 00000000-… uuids don't collide). Workspace + project ids
 * read their sibling lists straight from the stores; detail ids (dashboard, cohort, …) are
 * shortened against siblings passed by the caller, or with the plain 8-char prefix otherwise.
 */
import { shortenId, shortenIdAmong } from './short-id'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'

/** Shorten a workspace id against all known workspaces (unique prefix). */
export function shortWorkspaceId(wsUid: string): string {
  const all = useWorkspaceStore.getState()._workspacesRaw.map((w) => w.id)
  return shortenIdAmong(wsUid, all)
}

/** Shorten a project uid against all known projects (unique prefix). */
export function shortProjectId(projectUid: string): string {
  const all = useAppStore.getState().projects.map((p) => p.uid)
  return shortenIdAmong(projectUid, all)
}

const ws = (wsUid: string) => `/workspaces/${shortWorkspaceId(wsUid)}`
const proj = (wsUid: string, projectUid: string) => `${ws(wsUid)}/projects/${shortProjectId(projectUid)}`

export const paths = {
  workspace: (wsUid: string) => ws(wsUid),
  workspaceHome: (wsUid: string) => `${ws(wsUid)}/home`,
  workspaceSettings: (wsUid: string) => `${ws(wsUid)}/settings`,
  workspaceVersioning: (wsUid: string, tab?: 'export' | 'git') =>
    `${ws(wsUid)}/versioning${tab ? `?tab=${tab}` : ''}`,
  projects: (wsUid: string) => `${ws(wsUid)}/projects`,

  project: (wsUid: string, projectUid: string) => proj(wsUid, projectUid),
  projectSummary: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/summary`,
  projectSettings: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/settings`,
  projectVersioning: (wsUid: string, projectUid: string, tab?: 'export' | 'git') =>
    `${proj(wsUid, projectUid)}/versioning${tab ? `?tab=${tab}` : ''}`,

  // --- Project: warehouse ---
  databases: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/warehouse/databases`,
  cohorts: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/warehouse/cohorts`,
  cohort: (wsUid: string, projectUid: string, cohortId: string, siblings?: readonly string[]) =>
    `${proj(wsUid, projectUid)}/warehouse/cohorts/${siblings ? shortenIdAmong(cohortId, siblings) : shortenId(cohortId)}`,

  // --- Project: lab ---
  datasets: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/lab/datasets`,
  reports: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/lab/reports`,
  dashboards: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/lab/dashboards`,
  dashboard: (wsUid: string, projectUid: string, dashboardId: string, siblings?: readonly string[]) =>
    `${proj(wsUid, projectUid)}/lab/dashboards/${siblings ? shortenIdAmong(dashboardId, siblings) : shortenId(dashboardId)}`,

  // --- Workspace: warehouse list + detail ---
  warehouseEtl: (wsUid: string) => `${ws(wsUid)}/warehouse/etl`,
  warehouseDataQuality: (wsUid: string) => `${ws(wsUid)}/warehouse/data-quality`,
  warehouseSchemas: (wsUid: string) => `${ws(wsUid)}/warehouse/schemas`,
  warehouseDatabases: (wsUid: string) => `${ws(wsUid)}/warehouse/databases`,
  warehouseConceptMapping: (wsUid: string) => `${ws(wsUid)}/warehouse/concept-mapping/projects`,
  warehouseConceptMappingProject: (wsUid: string, mappingProjectId: string) =>
    `${ws(wsUid)}/warehouse/concept-mapping/${shortenId(mappingProjectId)}`,
  wiki: (wsUid: string) => `${ws(wsUid)}/wiki`,
} as const
