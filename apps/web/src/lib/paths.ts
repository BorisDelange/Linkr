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

/** Tabs shared by the project summary and the workspace home, keyed by `?tab=`. */
export type SummaryTab = 'overview' | 'readme' | 'license' | 'tasks'

const ws = (wsUid: string) => `/workspaces/${shortWorkspaceId(wsUid)}`
const proj = (wsUid: string, projectUid: string) => `${ws(wsUid)}/projects/${shortProjectId(projectUid)}`

export const paths = {
  workspace: (wsUid: string) => ws(wsUid),
  workspaceHome: (wsUid: string, tab?: SummaryTab) => `${ws(wsUid)}/home${tab ? `?tab=${tab}` : ''}`,
  workspaceSettings: (wsUid: string, tab?: string) => `${ws(wsUid)}/settings${tab ? `/${tab}` : ''}`,
  workspaceVersioning: (wsUid: string, tab?: 'export' | 'git') =>
    `${ws(wsUid)}/versioning${tab ? `?tab=${tab}` : ''}`,
  projects: (wsUid: string) => `${ws(wsUid)}/projects`,

  project: (wsUid: string, projectUid: string) => proj(wsUid, projectUid),
  projectSummary: (wsUid: string, projectUid: string, tab?: SummaryTab) =>
    `${proj(wsUid, projectUid)}/summary${tab ? `?tab=${tab}` : ''}`,
  projectSettings: (wsUid: string, projectUid: string, tab?: string) => `${proj(wsUid, projectUid)}/settings${tab ? `/${tab}` : ''}`,
  projectVersioning: (wsUid: string, projectUid: string, tab?: 'export' | 'git') =>
    `${proj(wsUid, projectUid)}/versioning${tab ? `?tab=${tab}` : ''}`,

  // --- Project: warehouse ---
  databases: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/warehouse/databases`,
  database: (wsUid: string, projectUid: string, dbId: string, siblings?: readonly string[]) =>
    `${proj(wsUid, projectUid)}/warehouse/databases/${siblings ? shortenIdAmong(dbId, siblings) : shortenId(dbId)}`,
  cohorts: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/warehouse/cohorts`,
  cohort: (wsUid: string, projectUid: string, cohortId: string, siblings?: readonly string[]) =>
    `${proj(wsUid, projectUid)}/warehouse/cohorts/${siblings ? shortenIdAmong(cohortId, siblings) : shortenId(cohortId)}`,
  patientData: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/warehouse/patient-data`,
  patientBoard: (wsUid: string, projectUid: string, boardId: string, siblings?: readonly string[]) =>
    `${proj(wsUid, projectUid)}/warehouse/patient-data/${siblings ? shortenIdAmong(boardId, siblings) : shortenId(boardId)}`,

  // --- Project: lab ---
  datasets: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/lab/datasets`,
  reports: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/lab/reports`,
  dashboards: (wsUid: string, projectUid: string) => `${proj(wsUid, projectUid)}/lab/dashboards`,
  dashboard: (wsUid: string, projectUid: string, dashboardId: string, siblings?: readonly string[]) =>
    `${proj(wsUid, projectUid)}/lab/dashboards/${siblings ? shortenIdAmong(dashboardId, siblings) : shortenId(dashboardId)}`,

  // --- Workspace: warehouse list + detail ---
  warehouseEtl: (wsUid: string) => `${ws(wsUid)}/warehouse/etl`,
  warehouseEtlPipeline: (wsUid: string, pipelineId: string) =>
    `${ws(wsUid)}/warehouse/etl/${shortenId(pipelineId)}`,
  warehouseDataQuality: (wsUid: string) => `${ws(wsUid)}/warehouse/data-quality`,
  warehouseDqRuleSet: (wsUid: string, ruleSetId: string) =>
    `${ws(wsUid)}/warehouse/data-quality/${shortenId(ruleSetId)}`,
  warehouseSchemas: (wsUid: string) => `${ws(wsUid)}/warehouse/schemas`,
  // Shortened like every other uuid-keyed entity. It used to carry the raw
  // presetId because that field was at once the key and the readable slug; the
  // slug now lives in `entityId` and the key is a uuid, so the exception went
  // with it (docs/planning/schema-preset-identity-plan.md).
  warehouseSchema: (wsUid: string, id: string) =>
    `${ws(wsUid)}/warehouse/schemas/${shortenId(id)}`,
  warehouseDatabases: (wsUid: string) => `${ws(wsUid)}/warehouse/databases`,
  warehouseDatabase: (wsUid: string, dbId: string, siblings?: readonly string[]) =>
    `${ws(wsUid)}/warehouse/databases/${siblings ? shortenIdAmong(dbId, siblings) : shortenId(dbId)}`,
  warehouseConceptMapping: (wsUid: string) => `${ws(wsUid)}/warehouse/concept-mapping/projects`,
  warehouseConceptMappingProject: (wsUid: string, mappingProjectId: string) =>
    `${ws(wsUid)}/warehouse/concept-mapping/${shortenId(mappingProjectId)}`,
  warehouseSqlScripts: (wsUid: string) => `${ws(wsUid)}/warehouse/sql-scripts`,
  warehouseSqlCollection: (wsUid: string, collectionId: string) =>
    `${ws(wsUid)}/warehouse/sql-scripts/${shortenId(collectionId)}`,
  warehouseDataCatalogs: (wsUid: string) => `${ws(wsUid)}/warehouse/catalog`,
  warehouseDataCatalog: (wsUid: string, catalogId: string) =>
    `${ws(wsUid)}/warehouse/catalog/${shortenId(catalogId)}`,
  wiki: (wsUid: string) => `${ws(wsUid)}/wiki`,
  plugins: (wsUid: string) => `${ws(wsUid)}/plugins`,
} as const
