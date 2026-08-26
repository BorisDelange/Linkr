/**
 * Turn a mapping project's 3-way merge into the generic pull plan (lib/pull-plan).
 *
 * The merge already decides *what* is coming in; this maps each outcome onto the
 * repo file that carries it, so Details can list files and Quick actions can list
 * objects without either inventing its own classification.
 *
 * Only candidate items reach a row — `mergeMetadata` yields the whitelisted fields
 * the remote actually moved, `mergeMappings` yields the mappings that need action.
 * That is what makes ticking a file do exactly what it says (see pull-plan.ts).
 */
import type { MappingProject } from '@/types'
import { ENTITY_MANIFEST } from '@linkr/format'
import { buildPullFiles, type PullFile, type PullItem, type PullPlan } from '@/lib/pull-plan'
import type { PreparedPull } from './pull'
import type { MappingChange } from './merge'

/** Repo file that carries each merged family. */
const MAPPINGS_FILE = 'mappings.json'
const PROJECT_FILE = ENTITY_MANIFEST
const SOURCE_CSV = 'source-concepts.csv'

/** Fields that live as their own file rather than inside project.json. */
const DOC_FILES: Partial<Record<string, string>> = {
  readme: 'README.md',
  license: 'LICENSE.md',
}

/** A mapping's human label: its source concept, which is what the user recognises. */
function mappingLabel(change: MappingChange): string {
  const m = change.remote ?? change.local ?? change.base
  if (!m) return change.key
  const code = m.sourceConceptCode ?? ''
  const name = m.sourceConceptName ?? ''
  return [code, name].filter(Boolean).join(' — ') || change.key
}

/** Short preview of a metadata value for the row's detail column. */
function fieldPreview(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 60)}…` : value
  if (typeof value === 'object') {
    // readme/license are objects; their diff is worth a viewer, not a preview.
    return ''
  }
  return String(value)
}

/**
 * Build the plan. `prepared` is the merge already computed by
 * `prepareMappingProjectPull`; nothing here does I/O.
 */
export function buildMappingProjectPullPlan(prepared: PreparedPull, branch: string): PullPlan {
  const { merge } = prepared

  // --- mappings.json ------------------------------------------------------
  const mappingItems: PullItem[] = merge.mappings.map((change) => ({
    key: change.key,
    label: mappingLabel(change),
    state: change.type,
    detail: change.remote?.targetConceptName ?? undefined,
  }))

  // --- project.json + docs ------------------------------------------------
  // A field that lives in its own file (README/LICENSE) is listed under THAT
  // file, so the user ticks the thing whose diff they can actually read.
  const metaByFile = new Map<string, PullItem[]>()
  const pushMeta = (field: string, item: PullItem) => {
    const path = DOC_FILES[field] ?? PROJECT_FILE
    const list = metaByFile.get(path) ?? []
    list.push(item)
    metaByFile.set(path, list)
  }

  for (const update of merge.metadata.cleanUpdates) {
    pushMeta(update.field, {
      key: update.field,
      label: update.field,
      state: 'update',
      detail: fieldPreview(update.value),
    })
  }
  for (const conflict of merge.metadata.conflicts) {
    pushMeta(conflict.field, {
      key: conflict.field,
      label: conflict.field,
      state: 'conflict',
      detail: fieldPreview(conflict.remote),
    })
  }

  // --- source-concepts.csv ------------------------------------------------
  // The row-level diff gives real counts; when the CSV could not be keyed we fall
  // back to a whole-file choice rather than show a meaningless 0/0.
  const diff = prepared.sourceConceptsDiff
  const sourceRows: { path: string; items: PullItem[]; wholeFile?: boolean; pickable?: boolean }[] = []
  if (merge.sourceConcepts.changed) {
    if (diff?.keyed) {
      const items: PullItem[] = []
      if (diff.added > 0) items.push({ key: 'added', label: 'added', state: 'add', detail: String(diff.added) })
      if (diff.removed > 0) items.push({ key: 'removed', label: 'removed', state: 'delete', detail: String(diff.removed) })
      if (diff.modified > 0) items.push({ key: 'modified', label: 'modified', state: 'update', detail: String(diff.modified) })
      // Pickable so the user can SEE which concepts move before deciding — losing
      // five that have mappings attached is the case worth catching. The review is
      // per row; the decision stays all-or-nothing, because the CSV is written
      // wholesale and a per-row tick could not be honoured.
      sourceRows.push({ path: SOURCE_CSV, items, pickable: true })
    } else {
      // Unkeyable (LFS pointer, missing identity column): no rows to list, but the
      // review screen still earns its place — it is where the user learns WHY the
      // list can't be compared, and the totals on each side.
      sourceRows.push({ path: SOURCE_CSV, items: [], wholeFile: true, pickable: true })
    }
  }

  // source-concept-ids/ is deliberately absent: its merge is monotone, so it is
  // applied on every pull without a choice (see pull-source-concept-ids.ts).
  // Listing it would ask the user to arbitrate something that has no wrong answer.
  const files: PullFile[] = buildPullFiles('mapping-projects', [
    // Metadata fields are ticked from the row/card directly — few enough that a
    // picker would be more clicks, not fewer.
    ...[...metaByFile.entries()].map(([path, items]) => ({ path, items })),
    { path: MAPPINGS_FILE, items: mappingItems, pickable: true },
    ...sourceRows,
  ])

  return { scope: 'mapping-projects', branch, remoteHead: prepared.remoteHead, files }
}

/** The metadata fields a pull may ever move — mirrors merge.ts METADATA_FIELDS.
 *  Exported so a test can assert the whitelist is closed (a foreign project.json
 *  must never be able to move an id or a timestamp). */
export const PULLABLE_METADATA_FIELDS: readonly (keyof MappingProject)[] = [
  'name', 'description', 'badges', 'status', 'readme', 'license',
]
