/**
 * The diff viewer for a project pull, over its TEXT files (scripts).
 *
 * A project row is a group (`scripts/`), not a file, so there is no single
 * before/after to show for the row itself. What the user wants to read is one
 * script at a time — so the dialog is fed a SYNTHETIC plan whose rows are the
 * individual scripts, and each row's diff is the plain local-vs-remote content.
 * The real plan keeps its group shape; this projection exists only to be read.
 *
 * Only scripts get this. Dashboards, cohorts, datasets and the pipeline are
 * structured entities whose export is a rewritten JSON document — diffing them
 * would parade regenerated ids and key reordering rather than the change the user
 * made, which is exactly what `pull-plan`'s "show what will happen, not what
 * differs" rule warns against.
 *
 * Everything here is synchronous: `prepareProjectPull` already holds both sides.
 */
import { buildPullFiles, type PullFile, type PullPlan } from '@/lib/pull-plan'
import { monacoLanguageFor } from '@/lib/monaco-language'
import { PROJECT_GROUP_PATHS } from '@/lib/project-pull-plan-builder'
import type { PreparedProjectPull } from '@/lib/project-pull'
import type { PullDiffText } from '@/lib/concept-mapping/pull-diff'

/** The diff row path for a script — its tree path under the group folder, so the
 *  dialog's sidebar reads like the repo (`scripts/utils/analysis.py`). */
export const scriptDiffPath = (key: string): string => `${PROJECT_GROUP_PATHS.scripts}${key}`

/** Reverse `scriptDiffPath` — the plan and the local map are keyed by the bare key. */
const scriptKeyOf = (path: string): string => path.slice(PROJECT_GROUP_PATHS.scripts.length)

/**
 * A plan whose rows are the individual scripts on offer, for the dialog's sidebar.
 *
 * Built from the same items the real plan carries, so a script that is not
 * pullable cannot appear here and one that is cannot go missing.
 */
export function buildProjectDiffPlan(prepared: PreparedProjectPull, branch: string): PullPlan {
  const rows = prepared.plan.scripts.map((item) => ({
    path: scriptDiffPath(item.key),
    items: [{ key: item.key, label: item.key, state: item.exists ? ('update' as const) : ('add' as const) }],
  }))
  return {
    scope: 'projects',
    branch,
    remoteHead: prepared.clonedOid,
    files: buildPullFiles('projects', rows),
  }
}

/** The two sides of one script: what we hold, and what the remote would write. */
export function buildProjectPullDiff(
  file: PullFile,
  prepared: PreparedProjectPull,
  localContentByKey: Map<string, string | undefined>,
): PullDiffText {
  const key = scriptKeyOf(file.path)
  const remote = prepared.parsed.ideFiles.find((n) => n.type === 'file' && n.path === key)
  return {
    oldContent: localContentByKey.get(key) ?? '',
    newContent: remote?.content ?? '',
    language: monacoLanguageFor(key),
  }
}
