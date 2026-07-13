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

/** Compact JSON format for source-concept-id entries (smaller than one object per entry). */
export interface CompactSourceConceptIdEntries {
  /** Column order: [badgeLabel, vocabularyId, conceptCode, sourceConceptId, createdAt] */
  columns: ['badgeLabel', 'vocabularyId', 'conceptCode', 'sourceConceptId', 'createdAt']
  entries: [string, string, string, number, string][]
}

/** Serialize SourceConceptIdEntry[] to compact format for export. */
export function toCompactEntries(entries: SourceConceptIdEntry[]): CompactSourceConceptIdEntries {
  return {
    columns: ['badgeLabel', 'vocabularyId', 'conceptCode', 'sourceConceptId', 'createdAt'],
    entries: entries.map(e => [e.badgeLabel, e.vocabularyId, e.conceptCode, e.sourceConceptId, e.createdAt]),
  }
}

/** Deserialize compact or legacy entries.json into SourceConceptIdEntry[]. */
export function parseSourceConceptIdEntries(
  raw: CompactSourceConceptIdEntries | SourceConceptIdEntry[],
  workspaceId: string,
): SourceConceptIdEntry[] {
  // Legacy format: array of full objects
  if (Array.isArray(raw)) return raw

  // Compact format: { columns, entries }
  return raw.entries.map(([badgeLabel, vocabularyId, conceptCode, sourceConceptId, createdAt]) => ({
    id: `${workspaceId}__${badgeLabel}__${vocabularyId}__${conceptCode}`,
    workspaceId,
    badgeLabel,
    vocabularyId,
    conceptCode,
    sourceConceptId,
    createdAt,
  }))
}

const json = (data: unknown) => JSON.stringify(data, null, 2)

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
    if (range) ranges.push(range)
    entries.push(...es)
  }
  if (ranges.length === 0 && entries.length === 0) return

  if (ranges.length > 0) zip.file(`${prefix}source-concept-ids/ranges.json`, json(ranges))
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

  if (rangesFile) {
    const raw = JSON.parse(await rangesFile.async('string')) as SourceConceptIdRange[]
    for (const r of raw) {
      await storage.sourceConceptIdRanges.save({ ...r, workspaceId })
    }
  }
  if (entriesFile) {
    const raw = JSON.parse(await entriesFile.async('string')) as
      CompactSourceConceptIdEntries | SourceConceptIdEntry[]
    const entries = parseSourceConceptIdEntries(raw, workspaceId)
    if (entries.length > 0) await storage.sourceConceptIdEntries.saveBatch(entries)
  }
}
