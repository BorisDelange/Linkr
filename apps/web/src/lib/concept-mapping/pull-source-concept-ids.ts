/**
 * Pull the badge allocation registry (`source-concept-ids/`).
 *
 * These files were pushed but never pulled, so two instances assigning ids in
 * parallel drifted apart in silence — and a `sourceConceptId` ends up inside the
 * generated OMOP concepts, so the drift is not cosmetic.
 *
 * Unlike everything else in the pull, this needs **no user choice**: the merge is
 * monotone (a concept already known locally keeps its local id; a badge's `nextId`
 * becomes the max of both sides), which makes it commutative and idempotent — a
 * CRDT counter, not a negotiation. Applying it on every pull is strictly safer
 * than offering it, because declining it would leave the allocation diverged.
 *
 * The local id always wins on a collision: a `(vocab, code)` pair is global per
 * workspace, so adopting the remote's id would silently change the id every local
 * project already references.
 */
import type { SourceConceptIdEntry, SourceConceptIdRange } from '@/types'
import type { Storage } from '@/lib/storage'
import {
  mergeSourceConceptIdRegistry,
  parseSourceConceptIdEntries,
  reconcileImportedEntries,
  type CompactSourceConceptIdEntries,
  type SourceConceptIdGroup,
} from './source-concept-ids-io'

/** What the pull preview carries for the registry (both files may be absent). */
export interface RemoteRegistryFiles {
  ranges: string | null | undefined
  entries: string | null | undefined
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/**
 * Merge the remote registry into the local one. Returns how many entries and
 * ranges were written, so the caller can report "badge allocation synchronised"
 * rather than stay silent about a write the user did not ask for.
 */
export async function pullSourceConceptIds(
  storage: Storage,
  workspaceId: string,
  remote: RemoteRegistryFiles,
): Promise<{ entriesWritten: number; rangesWritten: number }> {
  const remoteRanges = parseJson<SourceConceptIdRange[]>(remote.ranges, [])
  const remoteRawEntries = parseJson<CompactSourceConceptIdEntries | SourceConceptIdEntry[] | null>(
    remote.entries,
    null,
  )
  const remoteEntries = remoteRawEntries ? parseSourceConceptIdEntries(remoteRawEntries, workspaceId) : []
  if (remoteRanges.length === 0 && remoteEntries.length === 0) {
    return { entriesWritten: 0, rangesWritten: 0 }
  }

  const [localRanges, localEntries] = await Promise.all([
    storage.sourceConceptIdRanges.getByWorkspace(workspaceId),
    storage.sourceConceptIdEntries.getByWorkspace(workspaceId),
  ])

  // Keep the local id wherever the pair is already known here. `divergedBadges` is
  // empty: resolveImportedRange (inside the registry merge) settles the windows,
  // and dropping entries for a badge whose window moved is an import-time concern —
  // here the local side is authoritative for the window by construction.
  const reconciled = reconcileImportedEntries(remoteEntries, localEntries)

  // Fold local and remote as two groups: the merge keeps the first writer per key
  // (local first → local wins) and takes max(nextId) per badge, in either order.
  const localGroup: SourceConceptIdGroup = { ranges: localRanges, entries: localEntries }
  const remoteGroup: SourceConceptIdGroup = { ranges: remoteRanges, entries: reconciled }
  const merged = mergeSourceConceptIdRegistry([localGroup], remoteGroup)

  const knownEntryKeys = new Set(
    localEntries.map((e) => `${e.badgeLabel}__${e.vocabularyId}__${e.conceptCode}`),
  )
  const newEntries = merged.entries.filter(
    (e) => !knownEntryKeys.has(`${e.badgeLabel}__${e.vocabularyId}__${e.conceptCode}`),
  )
  if (newEntries.length > 0) {
    await storage.sourceConceptIdEntries.saveBatch(
      newEntries.map((e) => ({ ...e, workspaceId })),
    )
  }

  // Ranges are rewritten only where the merge actually moved them, so an
  // unchanged badge isn't touched on every pull.
  const localByBadge = new Map(localRanges.map((r) => [r.badgeLabel, r]))
  let rangesWritten = 0
  for (const range of merged.ranges) {
    const local = localByBadge.get(range.badgeLabel)
    if (
      local
      && local.rangeStart === range.rangeStart
      && local.rangeEnd === range.rangeEnd
      && local.nextId === range.nextId
    ) continue
    await storage.sourceConceptIdRanges.save({
      ...(local ?? {}),
      ...range,
      workspaceId,
    } as SourceConceptIdRange)
    rangesWritten++
  }

  return { entriesWritten: newEntries.length, rangesWritten }
}
