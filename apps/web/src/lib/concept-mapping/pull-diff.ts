/**
 * The text a pull diff shows: a projection of the merge plan, not a file diff.
 *
 * A raw `git diff` of `project.json` parades `uid`, `createdAt`, `ownerId` — all
 * different between two instances, all perfectly normal, and none of them ever
 * imported. Showing them would be a lie: the user ticks expecting all of it and
 * gets six fields. So each side is rebuilt from the *candidate items only*, which
 * makes ticking a row do exactly what the diff showed.
 *
 * It also keeps the payload small by construction: a 61 925-row CSV renders as the
 * handful of rows that moved, so the viewer never receives megabytes.
 *
 * Convention matches the push viewer: `oldContent` is what we'd be moving away
 * from (mine), `newContent` is what we'd land on (theirs).
 */
import type { ConceptMapping } from '@/types'
import type { PullFile } from '@/lib/pull-plan'
import type { MappingChange, MappingProjectMerge } from './merge'
import type { SourceConceptsDiff } from '@/lib/api/git'

export interface PullDiffText {
  oldContent: string
  newContent: string
  /** Monaco language for the rendered projection. */
  language: string
  /** Set when there is nothing textual to render (e.g. an unkeyable whole file). */
  notice?: 'whole_file'
}

const stable = (value: unknown): string => JSON.stringify(value ?? null, null, 2)

/** Stands in for "this side doesn't have it" — distinct from a null value. */
const ABSENT = '(absent)'
/** Stands in for "you didn't change this field" on a clean remote update. */
const UNCHANGED = '(unchanged)'

/**
 * The compared content of a mapping — identity fields are the key, not content.
 *
 * An absent side reads as "(absent)" rather than `null`: on an addition the whole
 * left column would otherwise be nulls, which looks like "the value is null" and
 * not "I don't have this mapping".
 */
function mappingBody(m: ConceptMapping | null): unknown {
  if (!m) return ABSENT
  return {
    target: [m.targetVocabularyId, m.targetConceptCode, m.targetConceptName].filter(Boolean).join(' · '),
    equivalence: m.equivalence,
    status: m.status,
    conceptSetId: m.conceptSetId,
    mappedBy: m.mappedBy,
    reviewedBy: m.reviewedBy,
    comments: m.comments,
  }
}

/**
 * A readable label for a mapping change, used as the projection's object key.
 *
 * The TARGET is part of it, not decoration: a mapping is identified by
 * source→target (see `mappingKey`), so one source concept can legitimately have
 * several mappings. Keying the projection on the source alone made them collide —
 * the last one silently overwrote the others and the diff showed fewer changes
 * than the pull would actually apply.
 */
function changeLabel(change: MappingChange): string {
  const m = change.remote ?? change.local ?? change.base
  const source = [m?.sourceVocabularyId, m?.sourceConceptCode].filter(Boolean).join('|')
  const target = [m?.targetVocabularyId, m?.targetConceptCode].filter(Boolean).join('|')
  if (!source) return change.key
  return target ? `${source} → ${target}` : source
}

/**
 * Build the two sides for one file of the plan.
 *
 * `merge` supplies the mapping/metadata plans; `sourceDiff` the row counts for the
 * source list (which has no per-row payload in the preview — only the counts).
 */
export function buildPullDiff(
  file: PullFile,
  merge: MappingProjectMerge,
  sourceDiff: SourceConceptsDiff | undefined,
): PullDiffText {
  if (file.path === 'mappings.json') {
    const mine: Record<string, unknown> = {}
    const theirs: Record<string, unknown> = {}
    for (const change of merge.mappings) {
      const label = changeLabel(change)
      mine[label] = mappingBody(change.local)
      theirs[label] = mappingBody(change.remote)
    }
    return { oldContent: stable(mine), newContent: stable(theirs), language: 'json' }
  }

  if (file.path === 'source-concepts.csv') {
    // The preview ships counts, not rows (a 5 MB CSV would cost more than the
    // pull). Render the tally rather than pretend to a row-by-row diff.
    if (!sourceDiff?.keyed) return { oldContent: '', newContent: '', language: 'text', notice: 'whole_file' }
    const mine = { concepts: sourceDiff.localTotal }
    const theirs = {
      concepts: sourceDiff.remoteTotal,
      added: sourceDiff.added,
      removed: sourceDiff.removed,
      modified: sourceDiff.modified,
    }
    return { oldContent: stable(mine), newContent: stable(theirs), language: 'json' }
  }

  // project.json and the docs files: only the candidate fields this row carries.
  const keys = new Set(file.items.map((i) => i.key))
  const mine: Record<string, unknown> = {}
  const theirs: Record<string, unknown> = {}
  for (const update of merge.metadata.cleanUpdates) {
    if (!keys.has(update.field)) continue
    // A clean update means the remote moved and we did not, so our side is the
    // value at the merge base — which the preview doesn't carry per field. Say so
    // rather than print `null`, which reads as "my value is null".
    mine[update.field] = UNCHANGED
    theirs[update.field] = update.value
  }
  for (const conflict of merge.metadata.conflicts) {
    if (!keys.has(conflict.field)) continue
    mine[conflict.field] = conflict.local
    theirs[conflict.field] = conflict.remote
  }
  // A doc file's whole point is its prose: render it as text, not as a JSON blob
  // with escaped newlines.
  if (keys.has('readme') || keys.has('license')) {
    const field = keys.has('readme') ? 'readme' : 'license'
    return {
      oldContent: docText(mine[field]),
      newContent: docText(theirs[field]),
      language: 'markdown',
    }
  }
  return { oldContent: stable(mine), newContent: stable(theirs), language: 'json' }
}

/** README/licence values are localized objects or plain strings; render the text. */
function docText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    // A localized string: show every language, labelled, so a pull that changes
    // only the French version is visible rather than silently identical.
    const parts = Object.entries(obj)
      .filter(([, v]) => typeof v === 'string')
      .map(([lang, v]) => `<!-- ${lang} -->\n${v as string}`)
    if (parts.length > 0) return parts.join('\n\n')
  }
  return stable(value)
}
