import { uniqueEtlFileName } from './etl-file-language'

/**
 * What to do when an upload lands on a name that already exists.
 *
 * Silently renaming to `x-2.sql` is the wrong default for a pipeline: the scripts
 * are numbered for the order they run in, and a second copy beside the original
 * is a step that never executes and a diff nobody asked for. So the user chooses,
 * and this module holds the decision logic — the dialog only renders it.
 */

/** How to resolve every clash in one upload. */
export type ConflictResolution = 'keep-both' | 'replace'

export interface UploadCandidate {
  /** The sanitised name the file would take. */
  name: string
  /** Text content, already read. */
  content: string
}

/** A file already in the pipeline, at the same parent. */
export interface ExistingFile {
  id: string
  name: string
}

export interface PlannedUpload {
  /** The name to actually create it under (may differ under 'keep-both'). */
  name: string
  content: string
  /** Set when an existing file must be overwritten rather than added. */
  replacesId?: string
}

export interface UploadPlan {
  creates: PlannedUpload[]
  /** Files to update in place (content only, keeping id/order/versioning marks). */
  replaces: { id: string; name: string; content: string }[]
}

/**
 * Which candidate names collide with what is already there.
 *
 * Case-insensitive: two files differing only in case are the same file to git on
 * macOS and Windows, and the export tree could not hold both.
 */
export function findConflicts(
  candidates: UploadCandidate[],
  existing: ExistingFile[],
): string[] {
  const taken = new Set(existing.map((f) => f.name.toLowerCase()))
  return candidates.filter((c) => taken.has(c.name.toLowerCase())).map((c) => c.name)
}

/**
 * The upload turned into concrete actions, given the user's choice.
 *
 * 'replace' updates the EXISTING file rather than deleting and recreating it, so
 * its id survives — and with it the versioning marks (keyed by path), the run
 * history that points at it, and its place in the execution order.
 */
export function planUpload(
  candidates: UploadCandidate[],
  existing: ExistingFile[],
  resolution: ConflictResolution,
): UploadPlan {
  const byName = new Map(existing.map((f) => [f.name.toLowerCase(), f]))
  // Reserved as we go, so two files in ONE drop cannot claim the same name.
  const taken = new Set(existing.map((f) => f.name.toLowerCase()))
  const plan: UploadPlan = { creates: [], replaces: [] }

  for (const candidate of candidates) {
    const clash = byName.get(candidate.name.toLowerCase())
    if (clash && resolution === 'replace') {
      plan.replaces.push({ id: clash.id, name: clash.name, content: candidate.content })
      continue
    }
    // uniqueEtlFileName owns the suffixing rule (and its case handling); this
    // module decides WHETHER to rename, not how.
    const name = uniqueEtlFileName(candidate.name, taken)
    taken.add(name.toLowerCase())
    plan.creates.push({ name, content: candidate.content })
  }
  return plan
}
