/**
 * Pull orchestration for a project — the additive-overlay model (not the
 * mapping-project 3-way merge). A project has an arbitrary file tree, so instead
 * of the managed-file `pull-preview`, we clone the remote to a ZIP (the same
 * primitive the import flow uses), parse it with `parseProjectZip`, and let the
 * user pick, per group, which remote entities to ADD or OVERWRITE locally.
 *
 * Groups: dashboards, IDE scripts, cohorts, datasets, pipeline, and the project
 * README + todos + notes. Databases are deliberately excluded — they're an
 * instance-level resource that doesn't travel with a project.
 *
 * Applying reuses the tested `importProjectContent` (deterministic ids → a pulled
 * entity lands on the same id it would on a fresh import), scoped to the chosen
 * groups. Overwrites delete the existing local entity first (the import loops are
 * insert-only). Finally the sync anchor is advanced to the cloned commit so the
 * behind/diverged banner clears.
 */
import type { Cohort, Dashboard, LocalizedString, Pipeline, Project, TodoItem } from '@/types'
import { getStorage } from '@/lib/storage'
import { gitCloneToZip, gitSetSyncState } from '@/lib/api/git'
import { cleanGitUrl } from '@/lib/git-clone'
import {
  parseProjectZip,
  importProjectContent,
  slugify,
  type ParsedProjectZip,
  type ProjectPullGroup,
} from '@/lib/entity-io'

/** One remote entity the user can choose to pull, within a group. */
export interface PullItem {
  /** Stable natural key within its group (path or name slug) — the selection id. */
  key: string
  /** Human label shown in the dialog (path or localized name). */
  label: string
  /** True when a local entity with the same natural key already exists → pulling
   *  it OVERWRITES rather than adds. */
  exists: boolean
}

export interface ProjectPullPlan {
  dashboards: PullItem[]
  scripts: PullItem[]
  cohorts: PullItem[]
  datasets: PullItem[]
  pipeline: PullItem[]
  /** The project's README/todos/notes differ from the local ones (a single block). */
  readmeChanged: boolean
}

export interface PreparedProjectPull {
  parsed: ParsedProjectZip
  plan: ProjectPullPlan
  /** The commit the clone landed on — the sync anchor after a successful pull. */
  clonedOid: string | null
  branch: string
}

/** The user's per-group selection (natural keys) + the readme block toggle. */
export interface ProjectPullSelection {
  dashboards: Set<string>
  scripts: Set<string>
  cohorts: Set<string>
  datasets: Set<string>
  pipeline: Set<string>
  readme: boolean
}

const localizedEn = (s: LocalizedString | string | undefined | null): string => {
  if (s == null) return ''
  if (typeof s === 'string') return s
  return s.en ?? Object.values(s)[0] ?? ''
}

/** Walk parentId up a flat file tree to build a display path (e.g. "a/b/c.sql"). */
function treePath<T extends { id: string; name: string; parentId: string | null }>(
  node: T,
  byId: Map<string, T>,
): string {
  const parts = [node.name]
  let cur: T | undefined = node
  while (cur?.parentId) {
    const parent = byId.get(cur.parentId)
    if (!parent) break
    parts.unshift(parent.name)
    cur = parent
  }
  return parts.join('/')
}

// --- Natural keys (stable across instances, independent of the local id) -----
const dashboardNaturalKey = (d: Dashboard): string => slugify(localizedEn(d.name) || d.id)
const cohortNaturalKey = (c: Cohort): string => slugify(c.name || c.id)
const pipelineNaturalKey = (p: Pipeline): string => slugify(localizedEn(p.name) || p.id)

/**
 * Clone the project's linked remote, parse it, and diff each group against the
 * local project to mark every remote entity new vs existing.
 */
export async function prepareProjectPull(
  projectUid: string,
  branch: string,
): Promise<PreparedProjectPull> {
  const storage = getStorage()
  const project = await storage.projects.getById(projectUid)
  const url = project?.gitRemoteConfig?.url
  if (!url) throw new Error('Project is not linked to a git remote')

  const cloned = await gitCloneToZip(cleanGitUrl(url), branch)
  const parsed = await parseProjectZip(new File([cloned.blob], 'pull.zip'))
  if (!parsed) throw new Error('Cloned repository is not a valid project export')

  // Local natural keys per group, to mark remote items new vs existing.
  const [localDashboards, localCohorts, localScripts, localDatasets, localPipelines] = await Promise.all([
    storage.dashboards.getByProject(projectUid),
    storage.cohorts.getByProject(projectUid),
    storage.ideFiles.getByProject(projectUid),
    storage.datasetFiles.getByProject(projectUid),
    storage.pipelines.getByProject(projectUid),
  ])

  const localDashKeys = new Set(localDashboards.map(dashboardNaturalKey))
  const localCohortKeys = new Set(localCohorts.map(cohortNaturalKey))
  const localPipelineKeys = new Set(localPipelines.map(pipelineNaturalKey))
  const localScriptById = new Map(localScripts.map((f) => [f.id, f]))
  const localScriptPaths = new Set(
    localScripts.filter((f) => f.type === 'file').map((f) => treePath(f, localScriptById)),
  )
  const localDsById = new Map(localDatasets.map((f) => [f.id, f]))
  const localDatasetPaths = new Set(
    localDatasets.filter((f) => f.type === 'file').map((f) => treePath(f, localDsById)),
  )

  const remoteDsById = new Map(parsed.datasetFiles.map((f) => [f.id, f]))

  const dashboards: PullItem[] = parsed.dashboards.map((d) => {
    const key = dashboardNaturalKey(d)
    return { key, label: localizedEn(d.name) || key, exists: localDashKeys.has(key) }
  })
  const cohorts: PullItem[] = parsed.cohorts.map((c) => {
    const key = cohortNaturalKey(c)
    return { key, label: c.name || key, exists: localCohortKeys.has(key) }
  })
  const pipeline: PullItem[] = parsed.pipelines.map((p) => {
    const key = pipelineNaturalKey(p)
    return { key, label: localizedEn(p.name) || key, exists: localPipelineKeys.has(key) }
  })
  const scripts: PullItem[] = parsed.ideFiles
    .filter((f) => f.type === 'file')
    .map((f) => ({ key: f.path, label: f.path, exists: localScriptPaths.has(f.path) }))
  const datasets: PullItem[] = parsed.datasetFiles
    .filter((f) => f.type === 'file')
    .map((f) => {
      const path = treePath(f, remoteDsById)
      return { key: path, label: path, exists: localDatasetPaths.has(path) }
    })

  const readmeChanged = await computeReadmeChanged(project, parsed.project)

  return {
    parsed,
    plan: { dashboards, scripts, cohorts, datasets, pipeline, readmeChanged },
    clonedOid: cloned.oid,
    branch,
  }
}

/** Does the remote README/todos/notes block differ from the local one? */
async function computeReadmeChanged(local: Project | undefined, remote: Project): Promise<boolean> {
  const norm = (v: unknown) => JSON.stringify(v ?? null)
  return (
    norm(local?.readme) !== norm(remote.readme) ||
    norm(local?.todos) !== norm(remote.todos) ||
    norm(local?.notes) !== norm(remote.notes)
  )
}

/**
 * Apply the resolved pull: overwrite the selected existing entities (delete first,
 * since the import loops are insert-only), import the chosen groups, update the
 * README block if picked, then advance the sync anchor to the cloned commit.
 */
export async function applyProjectPull(
  projectUid: string,
  prepared: PreparedProjectPull,
  selection: ProjectPullSelection,
): Promise<void> {
  const storage = getStorage()
  const { parsed, branch, clonedOid } = prepared

  // Groups with at least one chosen item drive importProjectContent's scope. The
  // filtered `parsed` below narrows each group down to the picked items, so a group
  // is included iff something in it is selected.
  const groups = new Set<ProjectPullGroup>()
  if (selection.dashboards.size) groups.add('dashboards')
  if (selection.scripts.size) groups.add('scripts')
  if (selection.cohorts.size) groups.add('cohorts')
  if (selection.datasets.size) groups.add('datasets')
  if (selection.pipeline.size) groups.add('pipeline')

  // Delete existing local entities the user chose to overwrite, so the insert-only
  // import loops don't hit a duplicate-key error and we replace rather than dupe.
  await deleteOverwrittenEntities(projectUid, prepared, selection)

  // Narrow the parsed content to exactly the picked items within each chosen group.
  const filtered = narrowParsed(parsed, selection)

  if (groups.size) {
    await importProjectContent(filtered, projectUid, storage, { groups })
  }

  if (selection.readme) {
    await storage.projects.update(projectUid, {
      readme: parsed.project.readme,
      todos: parsed.project.todos as TodoItem[] | undefined,
      notes: parsed.project.notes,
    })
  }

  // We're now in sync with the cloned commit — anchor to it so the behind/diverged
  // banner clears (server mode only; front-only has no anchor to set).
  if (clonedOid) {
    await gitSetSyncState('projects', projectUid, branch, clonedOid).catch(() => {})
  }
}

/** Build a ParsedProjectZip containing only the picked items of each group. */
function narrowParsed(parsed: ParsedProjectZip, sel: ProjectPullSelection): ParsedProjectZip {
  // Filter by natural key, not via an id Set: a key-based export carries no
  // dashboard ids, and Set([undefined]).has(undefined) would keep them ALL.
  const keptDashboards = parsed.dashboards.filter((d) => sel.dashboards.has(dashboardNaturalKey(d)))
  const keptDashIds = new Set(keptDashboards.map((d) => d.id).filter(Boolean))
  // Tabs/widgets ride with their dashboard. A parsed tab may carry a `key` (content
  // key) or a `dashboardId`; match on whichever links it to a kept dashboard.
  const keptTabs = parsed.dashboardTabs.filter((tab) => {
    if (tab.dashboardId && keptDashIds.has(tab.dashboardId)) return true
    // Key-based export: the tab key's first segment is the dashboard key.
    if (tab.key) return sel.dashboards.has(tab.key.split('/')[0])
    return false
  })
  const keptTabIds = new Set(keptTabs.map((t) => t.id))
  const keptTabKeys = new Set(keptTabs.map((t) => t.key).filter(Boolean) as string[])
  const keptWidgets = parsed.dashboardWidgets.filter((w) => {
    if (w.tabId && keptTabIds.has(w.tabId)) return true
    if (w.tabKey) return keptTabKeys.has(w.tabKey)
    return false
  })

  const remoteDsById = new Map(parsed.datasetFiles.map((f) => [f.id, f]))
  // Files match by path; folders are kept when any kept file needs them as an
  // ancestor (so the tree the import walks is complete).
  // Path-keyed nodes: select the chosen files directly (their folder ancestors are
  // re-synthesized from the paths at import, so no ancestor walk is needed).
  const keptScripts = parsed.ideFiles.filter((f) => f.type !== 'file' || sel.scripts.has(f.path))
  const keptDatasetFiles = keepTreeSelection(parsed.datasetFiles, remoteDsById, sel.datasets)
  const keptDatasetFileIds = new Set(keptDatasetFiles.filter((f) => f.type === 'file').map((f) => f.id))

  return {
    ...parsed,
    dashboards: keptDashboards,
    dashboardTabs: keptTabs,
    dashboardWidgets: keptWidgets,
    cohorts: parsed.cohorts.filter((c) => sel.cohorts.has(cohortNaturalKey(c))),
    pipelines: parsed.pipelines.filter((p) => sel.pipeline.has(pipelineNaturalKey(p))),
    ideFiles: keptScripts,
    datasetFiles: keptDatasetFiles,
    datasetData: parsed.datasetData.filter((d) => keptDatasetFileIds.has(d.datasetFileId)),
    datasetRawFiles: parsed.datasetRawFiles.filter((r) => keptDatasetFileIds.has(r.datasetFileId)),
    datasetAnalyses: parsed.datasetAnalyses.filter((a) => keptDatasetFileIds.has(a.datasetFileId)),
  }
}

/** Keep the tree nodes (files by path selection) plus every folder ancestor a kept
 *  file needs, so the import's parent-before-child walk finds each parent. */
function keepTreeSelection<T extends { id: string; name: string; parentId: string | null; type: string }>(
  nodes: T[],
  byId: Map<string, T>,
  selectedPaths: Set<string>,
): T[] {
  const keep = new Set<string>()
  for (const n of nodes) {
    if (n.type !== 'file') continue
    if (!selectedPaths.has(treePath(n, byId))) continue
    keep.add(n.id)
    let cur: T | undefined = n
    while (cur?.parentId) {
      keep.add(cur.parentId)
      cur = byId.get(cur.parentId)
    }
  }
  return nodes.filter((n) => keep.has(n.id))
}

/** Delete the local entities the user chose to OVERWRITE (existing natural keys),
 *  within the selected groups, before the insert-only import recreates them. */
async function deleteOverwrittenEntities(
  projectUid: string,
  prepared: PreparedProjectPull,
  sel: ProjectPullSelection,
): Promise<void> {
  const storage = getStorage()

  if (sel.dashboards.size) {
    const local = await storage.dashboards.getByProject(projectUid)
    for (const d of local) {
      if (!sel.dashboards.has(dashboardNaturalKey(d))) continue
      const tabs = await storage.dashboardTabs.getByDashboard(d.id)
      for (const tab of tabs) await storage.dashboardWidgets.deleteByTab(tab.id)
      await storage.dashboardTabs.deleteByDashboard(d.id)
      await storage.dashboards.delete(d.id)
    }
  }
  if (sel.cohorts.size) {
    const local = await storage.cohorts.getByProject(projectUid)
    for (const c of local) {
      if (sel.cohorts.has(cohortNaturalKey(c))) await storage.cohorts.delete(c.id)
    }
  }
  if (sel.pipeline.size) {
    const local = await storage.pipelines.getByProject(projectUid)
    for (const p of local) {
      if (sel.pipeline.has(pipelineNaturalKey(p))) await storage.pipelines.delete(p.id)
    }
  }
  if (sel.scripts.size) {
    const local = await storage.ideFiles.getByProject(projectUid)
    const byId = new Map(local.map((f) => [f.id, f]))
    for (const f of local) {
      if (f.type === 'file' && sel.scripts.has(treePath(f, byId))) await storage.ideFiles.delete(f.id)
    }
  }
  if (sel.datasets.size) {
    const local = await storage.datasetFiles.getByProject(projectUid)
    const byId = new Map(local.map((f) => [f.id, f]))
    for (const f of local) {
      if (f.type !== 'file' || !sel.datasets.has(treePath(f, byId))) continue
      // Analyses re-import at a deterministic id (mapId) via db.add, which throws
      // on a duplicate — delete them first (like the full-import cleanup) or the
      // overwrite leaves the dataset half-deleted. See entity-io deleteByDataset.
      await storage.datasetAnalyses.deleteByDataset(f.id).catch(() => {})
      await storage.datasetData.delete(f.id).catch(() => {})
      await storage.datasetRawFiles.delete(f.id).catch(() => {})
      await storage.datasetFiles.delete(f.id)
    }
  }
  void prepared
}
