/**
 * The diff viewer for a project pull: scripts, cohorts and the pipeline.
 *
 * A project row is a group (`scripts/`, `cohorts/`), not a file, so there is no
 * single before/after to show for the row itself. What the user wants to read is
 * one entity at a time — so the dialog is fed a SYNTHETIC plan whose rows are the
 * individual entities. The real plan keeps its group shape; this projection
 * exists only to be read.
 *
 * Scripts diff as plain text. Cohorts and pipelines diff as the JSON THE EXPORT
 * WRITES — `exportShape`, the same projection `prepareProjectPull` compares on.
 * That distinction is the whole point: diffing the raw rows would parade ids,
 * timestamps and the locally-resolved database, none of which the repo holds,
 * which is what `pull-plan`'s "show what will happen, not what differs" warns
 * against. Sorted keys, so the reordering of a JSON round-trip is not a change.
 *
 * Dashboards and datasets stay out: a dashboard exports as a bundle (board + tabs
 * + widgets re-keyed by content) that this module cannot rebuild from the plan
 * alone, and a dataset row is data, not a document.
 *
 * Everything here is synchronous: `prepareProjectPull` already holds both sides.
 */
import { buildPullFiles, type PullFile, type PullPlan } from '@/lib/pull-plan'
import { monacoLanguageFor } from '@/lib/monaco-language'
import { PROJECT_GROUP_PATHS } from '@/lib/project-pull-plan-builder'
import type { PreparedProjectPull } from '@/lib/project-pull'
import type { PullDiffText } from '@/lib/concept-mapping/pull-diff'

/** The groups whose rows open a diff. Order drives the viewer's sidebar. */
const DIFFABLE = ['scripts', 'cohorts', 'pipeline'] as const
type DiffableGroup = (typeof DIFFABLE)[number]

/** Is this plan row one the viewer can open? */
export const isDiffableGroupPath = (path: string): boolean =>
  DIFFABLE.some((g) => PROJECT_GROUP_PATHS[g] === path)

/** The diff row path for one entity — its key under the group folder, so the
 *  sidebar reads like the repo (`scripts/utils/analysis.py`, `cohorts/sepsis`). */
export const entityDiffPath = (group: DiffableGroup, key: string): string =>
  `${PROJECT_GROUP_PATHS[group]}${key}`

/** Split a row path back into its group and the bare key both sides are keyed by. */
const splitDiffPath = (path: string): { group: DiffableGroup; key: string } | null => {
  for (const group of DIFFABLE) {
    const prefix = PROJECT_GROUP_PATHS[group]
    if (path.startsWith(prefix)) return { group, key: path.slice(prefix.length) }
  }
  return null
}

/** JSON with keys sorted at every depth — the readable form of an export shape. */
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
  return JSON.stringify(sort(value) ?? null, null, 2)
}

/**
 * A plan whose rows are the individual entities on offer, for the sidebar.
 *
 * Built from the same items the real plan carries, so an entity that is not
 * pullable cannot appear here and one that is cannot go missing.
 */
export function buildProjectDiffPlan(prepared: PreparedProjectPull, branch: string): PullPlan {
  const rows = DIFFABLE.flatMap((group) =>
    prepared.plan[group].map((item) => ({
      path: entityDiffPath(group, item.key),
      items: [{
        key: item.key,
        label: item.label,
        state: item.exists ? ('update' as const) : ('add' as const),
      }],
    })),
  )
  return {
    scope: 'projects',
    branch,
    remoteHead: prepared.clonedOid,
    files: buildPullFiles('projects', rows),
  }
}

/** The two sides of one entity: what we hold, and what the remote would write. */
export function buildProjectPullDiff(
  file: PullFile,
  prepared: PreparedProjectPull,
  localContentByKey: Map<string, string | undefined>,
): PullDiffText {
  const parts = splitDiffPath(file.path)
  // A row that maps to no known group should never have reached the viewer;
  // degrade to a blank diff rather than throw.
  if (!parts) return { oldContent: '', newContent: '', language: 'json' }
  const { group, key } = parts

  if (group === 'scripts') {
    const remote = prepared.parsed.ideFiles.find((n) => n.type === 'file' && n.path === key)
    return {
      oldContent: localContentByKey.get(key) ?? '',
      newContent: remote?.content ?? '',
      language: monacoLanguageFor(key),
    }
  }

  // An absent side is a genuine state (the entity is being added, or is only
  // local), and renders as an empty pane rather than the string "null".
  const local = prepared.localExportShape[group].get(key)
  const remote = prepared.remoteExportShape[group].get(key)
  return {
    oldContent: local === undefined ? '' : stableJson(local),
    newContent: remote === undefined ? '' : stableJson(remote),
    language: 'json',
  }
}
