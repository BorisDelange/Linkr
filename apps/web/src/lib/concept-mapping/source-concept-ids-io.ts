/**
 * Export / import of the assigned source-concept-id registry.
 *
 * Assigned IDs live in a workspace-level registry (sourceConceptIdRanges +
 * sourceConceptIdEntries), keyed by (badgeLabel, vocabularyId, conceptCode) —
 * NOT on the mapping project or its mappings. So a plain project export
 * (project.json + mappings.json) loses them. This module serializes the subset
 * of the registry a project actually uses (its badges) into a
 * `source-concept-ids/` folder, and restores it on import.
 *
 * Lives here (not entity-io) so both the per-project export (export.ts) and the
 * whole-workspace export (entity-io.ts) can share it without an import cycle —
 * entity-io already imports from export.ts.
 */

import type JSZip from 'jszip'

import type { Storage } from '@/lib/storage'
import type { MappingProject, SourceConceptIdEntry, SourceConceptIdRange } from '@/types'
import { localized } from '@/lib/localized'

/**
 * Compact JSON format for source-concept-id entries (smaller than one object per
 * entry). `createdAt` is intentionally NOT serialized: it is per-entry instance
 * bookkeeping (a fresh timestamp at assignment), regenerated on import — versioning
 * it would add 177k timestamps of churn to a 20 MB file. Reads still accept an
 * older 5-column form that carried it. Rows are sorted by (badgeLabel, vocabularyId,
 * conceptCode) so DB iteration order never shows up as a spurious diff.
 */
export interface CompactSourceConceptIdEntries {
  /** Column order: [badgeLabel, vocabularyId, conceptCode, sourceConceptId] */
  columns: ['badgeLabel', 'vocabularyId', 'conceptCode', 'sourceConceptId']
  entries: [string, string, string, number][]
}

/**
 * Deterministic string order for VERSIONED exports. Do NOT use localeCompare here:
 * its result depends on the browser's locale + ICU version, so two clients (or one
 * after a browser update) could serialize the same data in a different order →
 * spurious git diffs, and it can't be reproduced byte-for-byte by the server's
 * Python builder. Ordering by code point is environment-independent and matches
 * Python's native `sorted()` — the two engines stay in lockstep. Concept codes are
 * BMP, so JS UTF-16-unit order and Python code-point order agree.
 */
export function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Serialize SourceConceptIdEntry[] to compact format for export (sorted, no timestamp). */
export function toCompactEntries(entries: SourceConceptIdEntry[]): CompactSourceConceptIdEntries {
  const rows: [string, string, string, number][] = entries.map(
    e => [e.badgeLabel, e.vocabularyId, e.conceptCode, e.sourceConceptId],
  )
  rows.sort((a, b) => compareCodePoints(a[0], b[0]) || compareCodePoints(a[1], b[1]) || compareCodePoints(a[2], b[2]))
  return { columns: ['badgeLabel', 'vocabularyId', 'conceptCode', 'sourceConceptId'], entries: rows }
}

/** Deserialize compact (4- or legacy 5-column) or legacy object-array entries.json. */
export function parseSourceConceptIdEntries(
  raw: CompactSourceConceptIdEntries | SourceConceptIdEntry[],
  workspaceId: string,
): SourceConceptIdEntry[] {
  // Legacy format: array of full objects
  if (Array.isArray(raw)) return raw.map(e => ({ ...e, workspaceId, id: `${workspaceId}__${e.badgeLabel}__${e.vocabularyId}__${e.conceptCode}` }))

  // Compact format: { columns, entries } — 5th column (createdAt) tolerated but ignored.
  // Short/malformed rows are dropped rather than producing entries with undefined
  // fields (which would mint broken ids and NaN sourceConceptIds downstream).
  const now = new Date().toISOString()
  return raw.entries
    .filter(
      (row): row is [string, string, string, number] =>
        Array.isArray(row) &&
        row.length >= 4 &&
        typeof row[0] === 'string' &&
        typeof row[1] === 'string' &&
        typeof row[2] === 'string' &&
        Number.isFinite(row[3]),
    )
    .map(([badgeLabel, vocabularyId, conceptCode, sourceConceptId]) => ({
      id: `${workspaceId}__${badgeLabel}__${vocabularyId}__${conceptCode}`,
      workspaceId,
      badgeLabel,
      vocabularyId,
      conceptCode,
      sourceConceptId,
      createdAt: now,
    }))
}

const json = (data: unknown) => JSON.stringify(data, null, 2)

/**
 * Reconcile imported entries against the ids already assigned in the target
 * workspace. A source_concept_id is GLOBAL per (vocab, code) in a workspace, so if
 * a concept the ZIP carries already has a LOCALLY-assigned id (from any badge, i.e.
 * another project), we keep the local id — importing the ZIP's id would change it
 * under every local project that already references it.
 *
 * `divergedBadges` lists badges whose LOCAL allocation window differs from the
 * imported one (see resolveImportedRange). For those, a NEW concept (no local id)
 * carries an imported id that falls OUTSIDE the local window — importing it would
 * create an out-of-window id. So we DROP it: it stays unassigned and gets a
 * local-window id at the next assign. Concepts the workspace has already seen keep
 * their local id; new concepts on compatible/absent windows keep the ZIP's id.
 * Pure, so it's unit-testable on its own.
 */
export function reconcileImportedEntries(
  imported: SourceConceptIdEntry[],
  existing: Pick<SourceConceptIdEntry, 'vocabularyId' | 'conceptCode' | 'sourceConceptId'>[],
  divergedBadges: ReadonlySet<string> = new Set(),
): SourceConceptIdEntry[] {
  const localIdByPair = new Map<string, number>()
  for (const e of existing) {
    const pair = `${e.vocabularyId}__${e.conceptCode}`
    if (!localIdByPair.has(pair)) localIdByPair.set(pair, e.sourceConceptId)
  }
  const out: SourceConceptIdEntry[] = []
  for (const e of imported) {
    const localId = localIdByPair.get(`${e.vocabularyId}__${e.conceptCode}`)
    if (localId != null) {
      out.push({ ...e, sourceConceptId: localId })
    } else if (!divergedBadges.has(e.badgeLabel)) {
      out.push(e)
    }
    // else: new concept on a diverged badge → drop (out-of-window id).
  }
  return out
}

/** Portable subset of a range for versioning: the allocation (start/end/nextId +
 *  totalConcepts) and its badge key. `workspaceId` is dropped (re-set to the target
 *  workspace on import) and the timestamps are dropped (instance bookkeeping,
 *  regenerated on import) so ranges.json tracks the allocation, not the instance. */
type PortableRange = Pick<SourceConceptIdRange, 'badgeLabel' | 'rangeStart' | 'rangeEnd' | 'nextId' | 'totalConcepts'>

/** Do two ranges describe the SAME allocation window (same start/end)? A badge is
 *  meant to have one window per workspace; if two instances moved it differently,
 *  they diverged and their assigned ids are incompatible. */
function sameWindow(a: { rangeStart: number; rangeEnd: number }, b: { rangeStart: number; rangeEnd: number }): boolean {
  return a.rangeStart === b.rangeStart && a.rangeEnd === b.rangeEnd
}

/**
 * Decide the range to persist on import, given the local range (if any) and the
 * imported one. Rules (see docs/architecture.md, "Versioning (as-built)"):
 *  - no local range → take the imported one.
 *  - same window → keep the local window but advance nextId to max(local, imported)
 *    (MONOTONE: the allocation counter must never go backwards, or a later assign
 *    would re-hand-out ids already consumed elsewhere).
 *  - different window (moved) → the LOCAL window is authoritative; ignore the import.
 * Returns { range, windowDiverged } — the caller uses windowDiverged to skip
 * out-of-window imported entries for new concepts.
 */
export function resolveImportedRange(
  local: SourceConceptIdRange | undefined,
  imported: PortableRange,
): { range: PortableRange; windowDiverged: boolean } {
  if (!local) return { range: imported, windowDiverged: false }
  if (sameWindow(local, imported)) {
    return {
      range: { ...local, nextId: Math.max(local.nextId, imported.nextId) },
      windowDiverged: false,
    }
  }
  // Diverged window: local wins entirely.
  return {
    range: { badgeLabel: local.badgeLabel, rangeStart: local.rangeStart, rangeEnd: local.rangeEnd, nextId: local.nextId, totalConcepts: local.totalConcepts },
    windowDiverged: true,
  }
}

/**
 * Reconcile a range's allocation counters with the ids actually assigned to its
 * badge. `nextId` and `totalConcepts` are written only at assign time, so a range
 * imported from a stale export (or produced by an older buggy assign) can carry
 * a `nextId` BELOW the highest id already handed out — a later assign would then
 * re-hand-out ids already in use. Deriving from the real entries fixes that:
 *
 *  - nextId        = max(range.nextId, max(entry.sourceConceptId) + 1)
 *  - totalConcepts = max(range.totalConcepts, entries.length)
 *
 * Monotone (never lowers a value), so it's safe to apply on every import and
 * every versioning read. Entries outside the range's window are ignored (they
 * belong to a different allocation and don't constrain this window's nextId).
 * Pure — unit-testable.
 */
export function reconcileRangeWithEntries<T extends PortableRange>(
  range: T,
  entries: Pick<SourceConceptIdEntry, 'sourceConceptId'>[],
): T {
  let maxId = 0
  let count = 0
  for (const e of entries) {
    const id = e.sourceConceptId
    if (id >= range.rangeStart && id <= range.rangeEnd) {
      count++
      if (id > maxId) maxId = id
    }
  }
  if (count === 0) return range
  return {
    ...range,
    nextId: Math.max(range.nextId, maxId + 1),
    totalConcepts: Math.max(range.totalConcepts ?? 0, count),
  }
}

export function toPortableRanges(ranges: SourceConceptIdRange[]): PortableRange[] {
  return ranges
    .map(({ badgeLabel, rangeStart, rangeEnd, nextId, totalConcepts }) => ({ badgeLabel, rangeStart, rangeEnd, nextId, totalConcepts }))
    .sort((a, b) => compareCodePoints(a.badgeLabel, b.badgeLabel))
}

/** (vocabularyId, conceptCode) universe of a project, keyed `vocab__code` —
 *  the same key `mergeSourceConceptIdRegistry` and SourceIdTab use. */
export type SourceConceptPairKey = string

export function sourceConceptPairKey(vocabularyId: string, conceptCode: string): SourceConceptPairKey {
  return `${vocabularyId}__${conceptCode}`
}

/**
 * Scope registry entries to the (vocab, code) a project actually carries, so a
 * single-project export keeps only its own ids — not every project's ids that
 * merely share the badge. Mirrors the server (source_concept_id_scope.py); without
 * it a front-only export (whole-badge) and a server export (scoped) churn a shared
 * git remote. `pairs` is the project's universe (mappings ∪ source dictionary).
 * Pure — unit-testable.
 */
export function scopeEntriesToProject(
  entries: SourceConceptIdEntry[],
  pairs: Set<SourceConceptPairKey>,
): SourceConceptIdEntry[] {
  return entries.filter((e) => pairs.has(sourceConceptPairKey(e.vocabularyId, e.conceptCode)))
}

/** One source of registry data read from a ZIP/seed: a set of ranges and entries,
 *  either the workspace root or a single mapping-project subfolder. */
export interface SourceConceptIdGroup {
  ranges: PortableRange[]
  entries: SourceConceptIdEntry[]
}

/**
 * Reconstruct the workspace registry from the workspace root group + each mapping
 * project's group (see docs/architecture.md, "Versioning (as-built)").
 *
 * RANGES: merged per badge with a monotone `nextId` (max across all groups) and
 * the widest window — via resolveImportedRange, so a stale root can never drag
 * nextId backwards once a project's group carries a fresher value.
 *
 * ENTRIES: per-project entries OWN their keys; the root is only a fallback. Groups
 * are applied in order (projectGroups first, root last) and a later group NEVER
 * overwrites an already-seen (badge, vocab, code) — so a stale root entry can't
 * shadow a project's fresher one, and a key only in the root still survives.
 *
 * Pure — unit-testable. Returns the ranges + entries to persist (workspaceId is
 * stamped by the caller).
 */
export function mergeSourceConceptIdRegistry(
  projectGroups: SourceConceptIdGroup[],
  rootGroup: SourceConceptIdGroup,
): { ranges: PortableRange[]; entries: SourceConceptIdEntry[] } {
  // --- ranges: monotone merge per badge ---
  const rangeByBadge = new Map<string, PortableRange>()
  const allRangeSources = [...projectGroups.flatMap((g) => g.ranges), ...rootGroup.ranges]
  for (const r of allRangeSources) {
    const seen = rangeByBadge.get(r.badgeLabel)
    // resolveImportedRange treats `local` as authoritative for the window and
    // takes max(nextId); feeding the accumulator as `local` makes the fold
    // order-independent for nextId (max is commutative).
    const merged = resolveImportedRange(seen as SourceConceptIdRange | undefined, r)
    rangeByBadge.set(r.badgeLabel, merged.range)
  }

  // --- entries: project-owned, root as fallback, first-writer-wins ---
  const entryByKey = new Map<string, SourceConceptIdEntry>()
  const key = (e: Pick<SourceConceptIdEntry, 'badgeLabel' | 'vocabularyId' | 'conceptCode'>) =>
    `${e.badgeLabel}__${e.vocabularyId}__${e.conceptCode}`
  for (const g of [...projectGroups, rootGroup]) {
    for (const e of g.entries) {
      const k = key(e)
      if (!entryByKey.has(k)) entryByKey.set(k, e)
    }
  }

  // Reconcile each range with its badge's real entries: a stale export can carry
  // a nextId below the ids already assigned, which a later assign would re-use.
  const entriesByBadge = new Map<string, SourceConceptIdEntry[]>()
  for (const e of entryByKey.values()) {
    const list = entriesByBadge.get(e.badgeLabel)
    if (list) list.push(e)
    else entriesByBadge.set(e.badgeLabel, [e])
  }
  const ranges = [...rangeByBadge.values()].map((r) =>
    reconcileRangeWithEntries(r, entriesByBadge.get(r.badgeLabel) ?? []),
  )

  return { ranges, entries: [...entryByKey.values()] }
}

/**
 * Write the project's assigned source-concept-ids into a `source-concept-ids/`
 * folder under `prefix` (ranges.json + entries.json, compact). Scoped to the
 * project's badges — the registry is workspace-wide, but only the labels this
 * project carries are relevant to it. No-op when the project has no badges or no
 * assigned IDs, so the folder is absent for projects that never assigned any.
 */
export async function buildProjectSourceConceptIds(
  zip: JSZip,
  prefix: string,
  project: MappingProject,
  storage: Storage,
): Promise<void> {
  // Badge labels key the workspace registry, so resolve to the canonical 'en'
  // value (stable across the UI language) — never the active-language string.
  const labels = (project.badges ?? []).map(b => localized(b.label, 'en')).filter(Boolean)
  if (labels.length === 0) return

  const ranges: SourceConceptIdRange[] = []
  const entries: SourceConceptIdEntry[] = []
  for (const label of labels) {
    const [range, es] = await Promise.all([
      storage.sourceConceptIdRanges.get(project.workspaceId, label),
      storage.sourceConceptIdEntries.getByWorkspaceAndBadge(project.workspaceId, label),
    ])
    // NOTE: front-only exports the WHOLE badge's entries, while the server scopes
    // them to the project's (vocab, code) via DuckDB (source_concept_id_scope.py).
    // scopeEntriesToProject exists to close that gap, but faithful scoping needs
    // the deduped source dictionary (the server reads it through the
    // `source_concepts` view); reproducing that here — CSV quoting, QUALIFY dedup,
    // terminology-column fallback — would risk a THIRD, divergent behaviour, so a
    // mixed front-only/server team still sees entries.json churn on a shared
    // remote. Tracked as a known limitation (docs/planning/versioning-plan.md §8).
    if (range) ranges.push(reconcileRangeWithEntries(range, es))
    entries.push(...es)
  }
  if (ranges.length === 0 && entries.length === 0) return

  if (ranges.length > 0) zip.file(`${prefix}source-concept-ids/ranges.json`, json(toPortableRanges(ranges)))
  if (entries.length > 0) {
    zip.file(`${prefix}source-concept-ids/entries.json`, json(toCompactEntries(entries)))
  }
}

/**
 * Restore a project's source-concept-ids from a `source-concept-ids/` folder if
 * present. Retargets entries/ranges to `workspaceId` (IDs are workspace-scoped;
 * an import into another workspace must re-key them). Optional and backward
 * compatible: older ZIPs simply have no folder, so this is a no-op for them.
 */
export async function importProjectSourceConceptIds(
  zip: JSZip,
  prefix: string,
  workspaceId: string,
  storage: Storage,
): Promise<void> {
  const rangesFile = zip.file(`${prefix}source-concept-ids/ranges.json`)
  const entriesFile = zip.file(`${prefix}source-concept-ids/entries.json`)

  // Badges whose local allocation window diverges from the imported one — imported
  // NEW-concept entries on these must be dropped (their ids are out of the local
  // window). Filled while merging ranges, consumed when reconciling entries.
  const divergedBadges = new Set<string>()

  // Parse the imported entries up front — they're needed to reconcile each range's
  // allocation counters (a stale export can carry a nextId below the ids assigned).
  let importedEntries: SourceConceptIdEntry[] = []
  if (entriesFile) {
    const raw = JSON.parse(await entriesFile.async('string')) as
      CompactSourceConceptIdEntries | SourceConceptIdEntry[]
    importedEntries = parseSourceConceptIdEntries(raw, workspaceId)
  }

  if (rangesFile) {
    // New exports carry the portable subset (no workspaceId/timestamps); older ones
    // the full object. Merge against the local range (monotone nextId, local window
    // authority) rather than blindly overwriting — see resolveImportedRange.
    const raw = JSON.parse(await rangesFile.async('string')) as (PortableRange & Partial<SourceConceptIdRange>)[]
    const now = new Date().toISOString()
    for (const r of raw) {
      const local = await storage.sourceConceptIdRanges.get(workspaceId, r.badgeLabel)
      const { range, windowDiverged } = resolveImportedRange(local, r)
      if (windowDiverged) divergedBadges.add(r.badgeLabel)
      // Fold in the ids actually present for this badge (local + imported), so a
      // stale nextId can't land below an already-assigned id.
      const badgeEntries = importedEntries.filter((e) => e.badgeLabel === range.badgeLabel)
      const reconciled = reconcileRangeWithEntries(range, badgeEntries)
      await storage.sourceConceptIdRanges.save({
        ...reconciled,
        workspaceId,
        createdAt: local?.createdAt ?? r.createdAt ?? now,
        updatedAt: now,
      })
    }
  }
  if (importedEntries.length > 0) {
    const existing = await storage.sourceConceptIdEntries.getByWorkspace(workspaceId)
    await storage.sourceConceptIdEntries.saveBatch(reconcileImportedEntries(importedEntries, existing, divergedBadges))
  }
}
