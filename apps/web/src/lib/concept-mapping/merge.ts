/**
 * 3-way merge for a mapping project's pullable content — pure logic, no I/O.
 *
 * The pull compares three snapshots of the same mapping project:
 *   - BASE   : the state at the last synced commit (the common ancestor)
 *   - REMOTE : the incoming state (what someone pushed)
 *   - LOCAL  : the current DB state (what we may have changed since BASE)
 *
 * By crossing BASE↔REMOTE ("what they changed") with BASE↔LOCAL ("what I
 * changed") we classify each unit without asking the user, and only surface a
 * conflict when BOTH sides changed the same unit differently. This mirrors
 * `git merge`, but on business objects (mappings, metadata fields) rather than
 * text lines — see docs/architecture.md, "Versioning (as-built)".
 *
 * Mappings are keyed by source+target (NOT by id — the id is regenerated on
 * import so it isn't stable across instances). Source concepts and
 * similarity scores are merged whole-list (block choice), and metadata per field.
 */
import type { ConceptMapping, MappingProject } from '@/types'

// --- Mapping identity + comparison ----------------------------------------

/** Stable cross-instance key: source concept → target concept (id is not stable). */
export function mappingKey(m: ConceptMapping): string {
  const s = `${m.sourceConceptId ?? ''}|${m.sourceVocabularyId ?? ''}|${m.sourceConceptCode ?? ''}`
  const t = `${m.targetConceptId ?? ''}|${m.targetVocabularyId ?? ''}|${m.targetConceptCode ?? ''}`
  return `${s}»→»${t}`
}

// Fields that constitute a *meaningful* change to a mapping. id/projectId and the
// timestamps are excluded (churn, not content); source/target identity is the key
// itself so a change there is a different unit, not a modification.
const COMPARED_FIELDS: (keyof ConceptMapping)[] = [
  'sourceConceptName', 'sourceDomainId', 'sourceFrequency',
  'sourceCategoryId', 'sourceSubcategoryId', 'sourceConceptClassId',
  'targetConceptName', 'targetDomainId', 'targetConceptClassId', 'targetStandardConcept',
  'conceptSetId', 'equivalence', 'status', 'matchScore',
  'comments', 'reviews',
  'mappedBy', 'mappedByDetails', 'mappedOn',
  'assignedReviewer', 'reviewedBy', 'reviewedByDetails', 'reviewedOn', 'reviewComment',
]

/** Deep-equal over the compared fields only (stable JSON for objects/arrays). */
export function mappingsEqual(a: ConceptMapping, b: ConceptMapping): boolean {
  for (const f of COMPARED_FIELDS) {
    if (!valueEqual(a[f], b[f])) return false
  }
  return true
}

function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // Treat null/undefined/'' as the same "empty" so optional-field noise (a field
  // present as undefined on one side, absent on the other) isn't a false change.
  if (a == null && b == null) return true
  if ((a == null || a === '') && (b == null || b === '')) return true
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

// --- Merge result types ----------------------------------------------------

export type MappingChangeType =
  | 'add' // present in REMOTE, absent in BASE and LOCAL → new remote mapping
  | 'update' // changed in REMOTE, unchanged locally → apply cleanly
  | 'delete' // removed in REMOTE, unchanged locally → propose removal
  | 'conflict' // both REMOTE and LOCAL changed the same key differently

export interface MappingChange {
  key: string
  type: MappingChangeType
  /** The REMOTE version (null when REMOTE deleted the mapping). */
  remote: ConceptMapping | null
  /** The LOCAL version (null when we don't have it). */
  local: ConceptMapping | null
  /** The BASE version (null when it didn't exist at the sync point). */
  base: ConceptMapping | null
}

export interface FieldConflict<T = unknown> {
  field: string
  base: T
  remote: T
  local: T
}

export interface MetadataMerge {
  /** Fields REMOTE changed while we didn't — safe to apply. */
  cleanUpdates: { field: string; value: unknown }[]
  /** Fields both sides changed differently — user picks mine/theirs per field. */
  conflicts: FieldConflict[]
}

export interface ListDiffStat {
  /** True when REMOTE differs from LOCAL for this whole-list family. */
  changed: boolean
  localCount: number
  remoteCount: number
  /** Remote byte size when the row count is unknown (LFS files) — for the label. */
  remoteByteSize?: number
  /** The remote file is LFS-tracked (row count unavailable without smudging). */
  remoteLfs?: boolean
}

export interface MappingProjectMerge {
  mappings: MappingChange[]
  metadata: MetadataMerge
  /** Whole-list family: block choice + a preview stat (rows fetched separately).
   *  Similarity scores are NOT here — they are gitignored (re-derivable, ~100 MB),
   *  so a repo never carries them and offering them proposed a file that could not
   *  exist. */
  sourceConcepts: ListDiffStat
}

// --- Mapping 3-way ---------------------------------------------------------

function byKey(list: ConceptMapping[]): Map<string, ConceptMapping> {
  const m = new Map<string, ConceptMapping>()
  for (const item of list) m.set(mappingKey(item), item)
  return m
}

/**
 * Classify every mapping key across the three snapshots. Only keys that need
 * action are returned (clean no-ops — unchanged, or identically changed on both
 * sides — are omitted, so the UI shows just what matters).
 */
export function mergeMappings(
  base: ConceptMapping[],
  remote: ConceptMapping[],
  local: ConceptMapping[],
): MappingChange[] {
  const b = byKey(base)
  const r = byKey(remote)
  const l = byKey(local)
  const keys = new Set<string>([...b.keys(), ...r.keys(), ...l.keys()])
  const changes: MappingChange[] = []

  for (const key of keys) {
    const bm = b.get(key) ?? null
    const rm = r.get(key) ?? null
    const lm = l.get(key) ?? null

    const remoteChanged = !sameOptional(bm, rm)
    const localChanged = !sameOptional(bm, lm)

    // Neither side touched it (or both are absent) → nothing to do.
    if (!remoteChanged) continue
    // REMOTE changed but LOCAL matches REMOTE already (both applied the same
    // edit independently) → no action needed.
    if (rm && lm && mappingsEqual(rm, lm)) continue

    if (!localChanged) {
      // Only REMOTE moved → clean apply.
      if (!bm && rm) changes.push({ key, type: 'add', remote: rm, local: lm, base: bm })
      else if (bm && !rm) changes.push({ key, type: 'delete', remote: null, local: lm, base: bm })
      else changes.push({ key, type: 'update', remote: rm, local: lm, base: bm })
    } else {
      // Both moved and they don't match → conflict (includes delete-vs-edit).
      changes.push({ key, type: 'conflict', remote: rm, local: lm, base: bm })
    }
  }
  return changes
}

/** Optional-aware equality between two mapping snapshots (either may be null). */
function sameOptional(a: ConceptMapping | null, b: ConceptMapping | null): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return mappingsEqual(a, b)
}

// --- Metadata 3-way (per field) --------------------------------------------

/** Project metadata fields the pull tracks (name/description + badges + docs).
 *  Kept small on purpose — instance fields (git/owner/timestamps) never merge.
 *  `readme` and `license` are not in project.json: pull.ts folds them in from
 *  README*.md / LICENSE.md so they get the same per-field 3-way, which makes a
 *  README edited on both sides a conflict instead of a silent overwrite. */
const METADATA_FIELDS: (keyof MappingProject)[] = ['name', 'description', 'badges', 'status', 'readme', 'license']

export function mergeMetadata(
  base: Partial<MappingProject>,
  remote: Partial<MappingProject>,
  local: Partial<MappingProject>,
): MetadataMerge {
  const cleanUpdates: { field: string; value: unknown }[] = []
  const conflicts: FieldConflict[] = []

  for (const field of METADATA_FIELDS) {
    const bv = base[field]
    const rv = remote[field]
    const lv = local[field]
    const remoteChanged = !metaEqual(bv, rv)
    if (!remoteChanged) continue
    const localChanged = !metaEqual(bv, lv)
    if (metaEqual(rv, lv)) continue // both ended up the same → no action
    if (!localChanged) cleanUpdates.push({ field: field as string, value: rv })
    else conflicts.push({ field: field as string, base: bv, remote: rv, local: lv })
  }
  return { cleanUpdates, conflicts }
}

function metaEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

// --- Whole-list families ---------------------------------------------------

export function listDiffStat(
  localCount: number,
  remoteCount: number,
  changed: boolean,
  extra?: { remoteByteSize?: number; remoteLfs?: boolean },
): ListDiffStat {
  return { changed, localCount, remoteCount, ...extra }
}
