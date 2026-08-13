/**
 * Turn a prepared project pull into the generic pull plan (lib/pull-plan).
 *
 * A project's groups are heterogeneous: scripts and datasets are keyed by their
 * tree path, while dashboards, cohorts and pipelines are keyed by a name slug
 * (their ids are regenerated on import, so the name is the only stable identity).
 * Each group therefore becomes ONE row — the export tree's folder — carrying its
 * entities as items, rather than one row per entity: `dashboards/` is the handle,
 * the dashboards inside it are what the user ticks.
 *
 * That also keeps the row count sane. A project with sixty scripts would otherwise
 * push its README off the bottom of the panel.
 */
import { buildPullFiles, type PullItem, type PullPlan } from '@/lib/pull-plan'
import type { PreparedProjectPull, ProjectPullPlan } from '@/lib/project-pull'

/** The export-tree folder that carries each group. */
export const PROJECT_GROUP_PATHS = {
  dashboards: 'dashboards/',
  scripts: 'scripts/',
  cohorts: 'cohorts/',
  datasets: 'datasets/',
  pipeline: 'pipeline/',
} as const

export type ProjectPullGroupKey = keyof typeof PROJECT_GROUP_PATHS

/** Groups in display order — the same order the dialog used. */
export const PROJECT_PULL_GROUPS: ProjectPullGroupKey[] = [
  'dashboards', 'scripts', 'cohorts', 'datasets', 'pipeline',
]

/** The row carrying the README/LICENSE/todos/notes block. */
export const PROJECT_DOCS_FILE = 'README.md'
/** Item key for that block (it is applied as one unit). */
export const PROJECT_DOCS_KEY = 'readme'

/** Reverse a row path back to its group — the apply needs the group, not the path. */
export function projectGroupForPath(path: string): ProjectPullGroupKey | null {
  for (const group of PROJECT_PULL_GROUPS) {
    if (PROJECT_GROUP_PATHS[group] === path) return group
  }
  return null
}

/**
 * Build the plan. `prepared` is the clone + diff already computed by
 * `prepareProjectPull`; nothing here does I/O.
 *
 * An entity absent locally is an `add`; one that already exists is an `update`
 * that overwrites. As with ETL there is no `conflict` state: the project pull has
 * no merge base, so it cannot distinguish "they changed it" from "we both did".
 * Calling every overwrite a conflict would drain the word of meaning; `update`
 * already carries the warning that something local gets replaced.
 */
export function buildProjectPullPlan(prepared: PreparedProjectPull, branch: string): PullPlan {
  const plan: ProjectPullPlan = prepared.plan
  const rows: { path: string; items: PullItem[]; wholeFile?: boolean; pickable?: boolean }[] = []

  for (const group of PROJECT_PULL_GROUPS) {
    const items: PullItem[] = plan[group].map((item) => ({
      key: item.key,
      label: item.label,
      state: item.exists ? 'update' : 'add',
    }))
    // Pickable so a group with many entities gets a table instead of a long
    // inline list; the row's counts stay readable either way.
    rows.push({ path: PROJECT_GROUP_PATHS[group], items, pickable: items.length > 1 })
  }

  if (plan.readmeChanged) {
    rows.push({
      path: PROJECT_DOCS_FILE,
      items: [{ key: PROJECT_DOCS_KEY, label: PROJECT_DOCS_KEY, state: 'update' }],
    })
  }

  return {
    scope: 'projects',
    branch,
    remoteHead: prepared.clonedOid,
    files: buildPullFiles('projects', rows),
  }
}
