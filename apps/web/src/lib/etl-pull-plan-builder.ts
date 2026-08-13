/**
 * Turn a prepared ETL pull into the generic pull plan (lib/pull-plan).
 *
 * Unlike a mapping project — where the applicable unit is a business object
 * buried inside one big file — an ETL pipeline's unit IS the file: a script, a
 * mapping, a doc. So each remote file becomes its own row, and the row is both
 * what the user ticks and what gets written.
 *
 * The one exception is the pipeline settings (name/description/config), which
 * live inside `_pipeline.json` and are applied as one block: they get a single
 * item on that file's row rather than a per-field choice, because the local
 * merge has no per-field base to arbitrate against.
 */
import { buildPullFiles, type PullItem, type PullPlan } from '@/lib/pull-plan'
import { ETL_PULL_GROUPS, etlPullGroupOf, type PreparedEtlPull } from '@/lib/etl-pull'

/** The manifest carrying the pipeline's own settings. */
export const ETL_SETTINGS_FILE = '_pipeline.json'
/** Item key for the settings block (the file's only unit). */
export const ETL_SETTINGS_KEY = 'settings'

/**
 * Build the plan. `prepared` is the clone + diff already computed by
 * `prepareEtlPull`; nothing here does I/O.
 *
 * A remote file absent locally is an `add`; one that exists is an `update` that
 * overwrites. There is no `conflict` state: the ETL pull has no merge base, so
 * it cannot tell "they changed it" from "we both did" — calling every overwrite
 * a conflict would make the word meaningless, and calling none of them one is
 * honest about what we actually know. `update` already warns it replaces.
 */
export function buildEtlPipelinePullPlan(prepared: PreparedEtlPull, branch: string): PullPlan {
  const rows: { path: string; items: PullItem[]; wholeFile?: boolean; pickable?: boolean }[] = []

  // Each remote file is its own row, and the row IS the unit — the file is what
  // the user ticks and what the apply writes. Hence `wholeFile`: giving it a
  // single child item named after the file would print the name twice (once as
  // the row, once as its own sub-row) and count "0/1 decided" for a thing that
  // has exactly one decision. The row's own accept/decline is the decision.
  for (const group of ETL_PULL_GROUPS) {
    for (const item of prepared.plan.groups[group]) {
      rows.push({
        path: item.key,
        items: [{
          key: item.key,
          label: item.key.split('/').pop() ?? item.key,
          state: item.exists ? 'update' : 'add',
        }],
        wholeFile: true,
      })
    }
  }

  // Same shape for the settings block: one manifest, one decision.
  if (prepared.plan.settingsChanged) {
    rows.push({
      path: ETL_SETTINGS_FILE,
      items: [{
        key: ETL_SETTINGS_KEY,
        label: ETL_SETTINGS_KEY,
        state: 'update',
      }],
      wholeFile: true,
    })
  }

  return {
    scope: 'etl-pipelines',
    branch,
    remoteHead: prepared.clonedOid,
    files: buildPullFiles('etl-pipelines', rows),
  }
}

/** Group a path belongs to — re-exported so the UI need not import both modules. */
export { etlPullGroupOf }
