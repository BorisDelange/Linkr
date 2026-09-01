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
import type {
  Cohort, Dashboard, LocalizedString, PatientDashboard, Pipeline, Project, TodoItem,
} from '@/types'
import { getStorage } from '@/lib/storage'
import { gitCloneToZip, gitSetSyncState } from '@/lib/api/git'
import { cleanGitUrl } from '@/lib/git-clone'
import { entityDocsChanged, entityDocsChanges, presentReadme } from '@/lib/entity-docs-pull'
import {
  parseProjectZip,
  importProjectContent,
  slugify,
  stripInstanceFields,
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
  patientDashboards: PullItem[]
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
  /** Local script content by tree path — the left side of the diff viewer, kept
   *  here so opening one costs no further read (see lib/project-pull-diff). */
  localScriptContent: Map<string, string | undefined>
  /**
   * The local cohorts/pipelines the plan compared against, AS THE EXPORT WRITES
   * THEM, keyed by natural key. This is the left side of their diff: showing the
   * raw row instead would parade ids and timestamps the repo never holds, so the
   * viewer must read the same projection the comparison used.
   */
  localExportShape: {
    cohorts: Map<string, unknown>
    pipeline: Map<string, unknown>
  }
  /** The same projection for the REMOTE side, keyed identically — the right side
   *  of that diff, so the viewer never re-derives a natural key of its own. */
  remoteExportShape: {
    cohorts: Map<string, unknown>
    pipeline: Map<string, unknown>
  }
}

/** The user's per-group selection (natural keys) + the readme block toggle. */
export interface ProjectPullSelection {
  dashboards: Set<string>
  patientDashboards: Set<string>
  scripts: Set<string>
  cohorts: Set<string>
  datasets: Set<string>
  pipeline: Set<string>
  readme: boolean
  /**
   * Deliberate "keep mine": take nothing, but still anchor on the remote commit.
   *
   * Distinct from an empty selection, which is merely an unfinished choice. The
   * user is resolving the divergence in favour of the local content, so the
   * behind banner must clear and the next push carry their version over the
   * remote's. Nothing is written — only the anchor moves.
   */
  keepLocal?: boolean
  /**
   * Every item on offer got an explicit verdict (taken or refused).
   *
   * Set by the inline pull, where refusing is a real act rather than an unfinished
   * selection. It advances the REVIEW cursor only — enough to unblock the push
   * without ever claiming we hold content we declined.
   */
  decided?: boolean
}

/**
 * Collapse CRLF/CR to LF before comparing two versions of a text file.
 *
 * Mirrors `_normalize_eol` in the backend's diff path: a script that only differs
 * by line-ending style is not a change worth offering to pull, and without this a
 * Windows-authored file would be reported as modified on every single pull.
 */
const sameText = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? '').replace(/\r\n?/g, '\n') === (b ?? '').replace(/\r\n?/g, '\n')

/**
 * Is this entity identical to the version the remote would write?
 *
 * Compared as the EXPORT sees them, not as they sit in the database: the repo
 * holds `stripInstanceFields(entity)` minus `dataSourceId`, so a raw comparison
 * would flag every local-only field (ids, timestamps, the resolved database) and
 * report the whole folder as modified right after a push. Key order is normalised
 * too — the two sides are built by different code paths (a JSON parse vs a live
 * row), so their key order has no reason to agree and is not a difference.
 *
 * The same projection the export applies is the only honest basis for "did this
 * actually change?" — the rule scripts and readmeChanged already follow.
 */
const sameExported = (local: unknown, remote: unknown): boolean =>
  stableJson(exportShape(local)) === stableJson(exportShape(remote))

/**
 * The export's projection of one entity, as `buildProjectZip` writes it.
 *
 * MUST drop everything the export drops. A field the export removes but this
 * keeps is present on one side and absent on the other, so the entity reads as
 * modified forever — which is exactly what happened when the cohort's run
 * results stopped being versioned and this projection did not follow. Keep this
 * list beside the one in `buildProjectZip` (cohorts/ section).
 */
const exportShape = (entity: unknown): Record<string, unknown> => {
  const out = stripInstanceFields(entity as never) as Record<string, unknown>
  const {
    // A local UUID addresses nothing elsewhere; `id` never travels for these
    // key-addressed entities.
    dataSourceId: _db, id: _id,
    // Cohort run results: counted against THIS instance's database, so they are
    // not part of the definition the repo holds.
    attrition: _attrition, resultCount: _resultCount,
    ...rest
  } = out
  return rest
}

/** JSON with keys sorted at every depth, so key order is never a difference. */
function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>).sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      )
    }
    return v
  }
  return JSON.stringify(sort(value) ?? null)
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
/** Matches the export filename (`patient-dashboards/<slug>.json`), like the others. */
const patientDashboardNaturalKey = (d: PatientDashboard): string =>
  slugify(localizedEn(d.name) || d.id)
const cohortNaturalKey = (c: Cohort): string => slugify(localizedEn(c.name) || c.id)
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
  const [
    localDashboards, localCohorts, localScripts, localDatasets, localPipelines, localPatientBoards,
  ] = await Promise.all([
    storage.dashboards.getByProject(projectUid),
    storage.cohorts.getByProject(projectUid),
    storage.ideFiles.getByProject(projectUid),
    storage.datasetFiles.getByProject(projectUid),
    storage.pipelines.getByProject(projectUid),
    storage.patientDashboards.getByProject(projectUid),
  ])

  // Keyed by natural key, and holding the row itself: an entity present on both
  // sides still has to be compared before it is offered as an "update".
  const localCohortByKey = new Map(localCohorts.map((c) => [cohortNaturalKey(c), c] as const))
  const localPipelineByKey = new Map(localPipelines.map((p) => [pipelineNaturalKey(p), p] as const))
  const localDashKeys = new Set(localDashboards.map(dashboardNaturalKey))
  const localPatientBoardKeys = new Set(localPatientBoards.map(patientDashboardNaturalKey))
  const localScriptById = new Map(localScripts.map((f) => [f.id, f]))
  const localScriptByPath = new Map(
    localScripts
      .filter((f) => f.type === 'file')
      .map((f) => [treePath(f, localScriptById), f] as const),
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
  // Like dashboards, a board is a BUNDLE (board + tabs + widgets) this module
  // cannot rebuild from the plan alone, so it is matched on the natural key and
  // taken whole — no content comparison, and no diff row (see project-pull-diff).
  const patientDashboards: PullItem[] = (parsed.patientDashboards ?? []).map((d) => {
    const key = patientDashboardNaturalKey(d)
    return { key, label: localizedEn(d.name) || key, exists: localPatientBoardKeys.has(key) }
  })
  // Like the scripts below: an entity identical to the remote is dropped rather
  // than offered as an overwrite of itself, or every push came straight back as a
  // pull of everything it had just sent.
  const cohorts: PullItem[] = parsed.cohorts
    .map((c) => ({ c, key: cohortNaturalKey(c) }))
    .filter(({ c, key }) => {
      const local = localCohortByKey.get(key)
      return !local || !sameExported(local, c)
    })
    .map(({ c, key }) => ({ key, label: localizedEn(c.name) || key, exists: localCohortByKey.has(key) }))
  const pipeline: PullItem[] = parsed.pipelines
    .map((p) => ({ p, key: pipelineNaturalKey(p) }))
    .filter(({ p, key }) => {
      const local = localPipelineByKey.get(key)
      return !local || !sameExported(local, p)
    })
    .map(({ p, key }) => ({ key, label: localizedEn(p.name) || key, exists: localPipelineByKey.has(key) }))
  // A script whose content already matches the remote is dropped, not listed as an
  // overwrite of itself: right after a push every path exists on both sides, so
  // marking on path alone reported the whole folder as "updated". Same rule as the
  // ETL pull (buildEtlPullPlan) and as readmeChanged — the content is what changed
  // or it did not. Only files survive this filter; folders never were pull items.
  const scripts: PullItem[] = parsed.ideFiles
    .filter((f) => f.type === 'file')
    .filter((f) => {
      const local = localScriptByPath.get(f.path)
      return !local || !sameText(local.content, f.content)
    })
    .map((f) => ({ key: f.path, label: f.path, exists: localScriptByPath.has(f.path) }))
  const datasets: PullItem[] = parsed.datasetFiles
    .filter((f) => f.type === 'file')
    .map((f) => {
      const path = treePath(f, remoteDsById)
      return { key: path, label: path, exists: localDatasetPaths.has(path) }
    })

  const readmeChanged = await computeReadmeChanged(project, parsed.project)

  return {
    parsed,
    plan: { dashboards, patientDashboards, scripts, cohorts, datasets, pipeline, readmeChanged },
    clonedOid: cloned.oid,
    branch,
    localScriptContent: new Map([...localScriptByPath].map(([p, f]) => [p, f.content])),
    localExportShape: {
      cohorts: new Map([...localCohortByKey].map(([k, c]) => [k, exportShape(c)])),
      pipeline: new Map([...localPipelineByKey].map(([k, p]) => [k, exportShape(p)])),
    },
    remoteExportShape: {
      cohorts: new Map(parsed.cohorts.map((c) => [cohortNaturalKey(c), exportShape(c)])),
      pipeline: new Map(parsed.pipelines.map((p) => [pipelineNaturalKey(p), exportShape(p)])),
    },
  }
}

/**
 * Does the remote README / LICENSE / todos / notes block differ from the local one?
 *
 * The licence is part of it: `parseProjectZip` already recombines LICENSE.md with
 * the id in project.json, but the pull used to compare and apply only
 * readme/todos/notes — so a remote licence was parsed and then dropped on the
 * floor. readme/license go through the shared docs helper, which every scope uses.
 */
async function computeReadmeChanged(local: Project | undefined, remote: Project): Promise<boolean> {
  const norm = (v: unknown) => JSON.stringify(v ?? null)
  return (
    entityDocsChanged(local, { readme: presentReadme(remote.readme), license: remote.license })
    || norm(local?.todos) !== norm(remote.todos)
    || norm(local?.notes) !== norm(remote.notes)
  )
}

/**
 * Did this selection take everything the plan offered?
 *
 * The anchor may only advance for a COMPLETE pull — it asserts "we hold the
 * content of this commit". Taking three of five dashboards and then claiming the
 * commit hides the other two for good: the behind banner clears and every later
 * plan is rebuilt against the new anchor, so they are never offered again.
 */
export function isCompleteProjectPull(
  plan: ProjectPullPlan,
  selection: ProjectPullSelection,
): boolean {
  if (plan.readmeChanged && !selection.readme) return false
  const groups = [
    'dashboards', 'patientDashboards', 'scripts', 'cohorts', 'datasets', 'pipeline',
  ] as const
  return groups.every((g) => plan[g].every((item) => selection[g].has(item.key)))
}

/**
 * Apply the resolved pull: overwrite the selected existing entities (delete first,
 * since the import loops are insert-only), import the chosen groups, update the
 * README block if picked, then advance the sync anchor to the cloned commit — but
 * only when everything on offer was taken.
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
  if (selection.patientDashboards.size) groups.add('patientDashboards')
  if (selection.scripts.size) groups.add('scripts')
  if (selection.cohorts.size) groups.add('cohorts')
  if (selection.datasets.size) groups.add('datasets')
  if (selection.pipeline.size) groups.add('pipeline')

  // Delete existing local entities the user chose to overwrite, so the insert-only
  // import loops don't hit a duplicate-key error and we replace rather than dupe.
  await deleteOverwrittenEntities(projectUid, selection)

  // Narrow the parsed content to exactly the picked items within each chosen group.
  const filtered = narrowParsed(parsed, selection)

  if (groups.size) {
    await importProjectContent(filtered, projectUid, storage, { groups })
  }

  if (selection.readme) {
    await storage.projects.update(projectUid, {
      ...entityDocsChanges({
        readme: presentReadme(parsed.project.readme),
        license: parsed.project.license,
      }),
      todos: parsed.project.todos as TodoItem[] | undefined,
      notes: parsed.project.notes,
    })
  }

  // Two cursors, two meanings. `syncedOid` asserts "we hold this commit's
  // content", so only a complete pull (or an explicit keep-mine) may advance it —
  // advancing it after a PARTIAL pull would clear the behind banner and hide the
  // un-taken items for good (see isCompleteProjectPull / mayAnchorProjectPull).
  // `reviewedOid` only asserts "we have decided about this commit", which is what
  // unblocks the push: a user who took some items and knowingly refused the rest
  // has resolved the divergence and must not stay stuck behind it.
  // (Server mode only; front-only has no anchor to set.)
  if (clonedOid) {
    // Only TAKING the content may advance `syncedOid`. Keep-local is a decision,
    // not an application: the user holds none of this commit, so recording it as
    // the 3-way base would make the merge treat what they declined as already
    // absorbed — and every later pull, diffed against that base, would stop
    // offering it. Those items are meant to reappear as local changes to push.
    const holdsContent = isCompleteProjectPull(prepared.plan, selection)
    if (holdsContent || selection.keepLocal || selection.decided) {
      await gitSetSyncState('projects', projectUid, branch, clonedOid, !holdsContent)
    }
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

  // Patient boards: same shape as dashboards, with flat tabs. Children ride with
  // their board — a tab's key is `<boardKey>/<slug>`, a widget names its tabKey.
  const keptBoards = (parsed.patientDashboards ?? [])
    .filter((d) => sel.patientDashboards.has(patientDashboardNaturalKey(d)))
  const keptBoardIds = new Set(keptBoards.map((d) => d.id).filter(Boolean))
  const keptBoardTabs = (parsed.patientDashboardTabs ?? []).filter((tab) => {
    if (tab.patientDashboardId && keptBoardIds.has(tab.patientDashboardId)) return true
    if (tab.key) return sel.patientDashboards.has(tab.key.split('/')[0])
    return false
  })
  const keptBoardTabIds = new Set(keptBoardTabs.map((t) => t.id))
  const keptBoardTabKeys = new Set(keptBoardTabs.map((t) => t.key).filter(Boolean) as string[])
  const keptBoardWidgets = (parsed.patientDashboardWidgets ?? []).filter((w) => {
    if (w.tabId && keptBoardTabIds.has(w.tabId)) return true
    if (w.tabKey) return keptBoardTabKeys.has(w.tabKey)
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
    patientDashboards: keptBoards,
    patientDashboardTabs: keptBoardTabs,
    patientDashboardWidgets: keptBoardWidgets,
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
  if (sel.patientDashboards.size) {
    const local = await storage.patientDashboards.getByProject(projectUid)
    for (const d of local) {
      if (!sel.patientDashboards.has(patientDashboardNaturalKey(d))) continue
      // Same teardown order as a dashboard: widgets, then tabs, then the board —
      // the import loops are insert-only, so a leftover child collides on its
      // deterministic id.
      const tabs = await storage.patientDashboardTabs.getByDashboard(d.id)
      for (const tab of tabs) await storage.patientDashboardWidgets.deleteByTab(tab.id)
      await storage.patientDashboardTabs.deleteByDashboard(d.id)
      await storage.patientDashboards.delete(d.id)
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
}
