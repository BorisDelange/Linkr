/**
 * Shared mapping-project importer — the single restore path for a mapping
 * project's full content, used by both the standalone git/ZIP import
 * (MappingProjectListPage) and the workspace-import auto-clone of git-linked
 * mapping projects (applyClonedEntity). Both routes parse the SAME repo/export
 * layout (project.json + mappings.json + source-concepts.csv +
 * source-concept-ids/ + similarity-scores.parquet), so they must restore it the
 * same way — otherwise one path silently drops source concepts / scores / ids
 * (the "imported but no concepts" bug).
 *
 * This module is UI-free: callers own the ZIP read + conflict handling and pass
 * the parsed contents in.
 */
import type { ConceptMapping, GitRemoteConfig, LocalizedString, MappingProject, SourceConceptIdRange } from '@/types'
import type { Storage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import { readLicense } from '@/lib/entity-io'
import { README_FILE_RE } from '@/lib/entity-tree'
import { restoreFileSourceDataFromCsv } from './export'
import { parseSourceConceptIdEntries } from './source-concept-ids-io'

export interface MappingProjectImportInput {
  /** Parsed export/repo contents (parseImportZip output): path → JSON|string. */
  files: Record<string, unknown>
  /** Precomputed suggestion scores, read as raw bytes (parquet is binary). */
  scoresBytes: Uint8Array | null
}

export interface MappingProjectImportOptions {
  /** Local PK to write under (already de-conflicted by the caller). */
  targetId: string
  /** Workspace the project belongs to. */
  workspaceId: string
  /** Replace any existing content under targetId first (overwrite/clone). */
  replaceExisting?: boolean
  /** Git link to keep on the restored project. The repo's own project.json never
   *  carries it (export strips it), so cloning a git-linked project would otherwise
   *  drop the link — pass it explicitly to preserve it. */
  gitRemoteConfig?: GitRemoteConfig
}

/**
 * Restore a mapping project's full content from a parsed export/repo ZIP.
 *
 * Order matters: the project row (carrying `fileSourceData` restored from
 * source-concepts.csv) is created first so the source-concept table is
 * populated; mappings, the source-concept-id registry, and scores follow. Each
 * post-row step is best-effort — a failure there must not lose the project.
 *
 * Returns true if a project row was found+written, false if the ZIP had no
 * project.json (nothing to import).
 */
export async function importMappingProjectContent(
  input: MappingProjectImportInput,
  options: MappingProjectImportOptions,
  storage: Storage,
): Promise<boolean> {
  const { files, scoresBytes } = input
  const { targetId, workspaceId, replaceExisting, gitRemoteConfig } = options
  const now = new Date().toISOString()

  // `readmeLang` is an export-only marker (which language the suffix-free
  // README.md holds); it rides on project.json but is not part of the entity.
  const project = files['project.json'] as (MappingProject & { readmeLang?: string }) | undefined
  if (!project?.id) return false

  if (replaceExisting) {
    await storage.conceptMappings.deleteByProject(targetId).catch(() => {})
    await storage.mappingProjects.delete(targetId).catch(() => {})
  }

  // Restore the source CSV → fileSourceData (+ rawFileBuffer) BEFORE create, so
  // the persisted project carries the source concepts the table renders.
  if (project.sourceType === 'file' && project.fileSourceData) {
    const sourceCsv = files['source-concepts.csv']
    if (typeof sourceCsv === 'string' && sourceCsv.length > 0) {
      restoreFileSourceDataFromCsv(project, sourceCsv)
    }
  }

  // README.md / LICENSE.md are files in the repo, not metadata: fold them back
  // onto the entity (the licence's id comes from project.json, its text from the file).
  const readmeByLang: LocalizedString = {}
  for (const [path, content] of Object.entries(files)) {
    const m = README_FILE_RE.exec(path)
    if (m && typeof content === 'string') {
      readmeByLang[m[1] ?? project.readmeLang ?? 'en'] = content
    }
  }
  const licenseText = files['LICENSE.md']
  const license = typeof licenseText === 'string'
    ? readLicense(project.license, licenseText)
    : project.license

  const entity: MappingProject = {
    ...project,
    id: targetId,
    workspaceId,
    ...(Object.keys(readmeByLang).length ? { readme: readmeByLang } : {}),
    ...(license ? { license } : {}),
    conceptSetIds: project.conceptSetIds ?? [],
    // gitRemoteConfig is set by the caller (import source), never from the ZIP
    // (export strips it). Cloning a git-linked project must keep the link.
    gitRemoteConfig,
    createdAt: project.createdAt ?? now,
    updatedAt: now,
    lineageId: project.lineageId ?? crypto.randomUUID(),
  }
  await storage.mappingProjects.create(entity)

  const mappings = (files['mappings.json'] ?? []) as ConceptMapping[]
  if (mappings.length > 0) {
    const toCreate = mappings.map((m) => {
      // Migrate legacy `comment` string → `comments[]` array (mirror standalone import).
      const legacy = (m as unknown as Record<string, unknown>).comment
      const migratedComments = (!m.comments?.length && typeof legacy === 'string' && legacy.trim())
        ? [{ id: crypto.randomUUID(), authorId: m.mappedBy ?? 'unknown', text: legacy.trim(), createdAt: m.mappedOn ?? now }]
        : m.comments
      return { ...m, comments: migratedComments, id: crypto.randomUUID(), projectId: targetId }
    })
    await storage.conceptMappings.createBatch(toCreate)
  }

  // Assigned source-concept-ids → workspace registry (retargeted to this ws).
  const rawRanges = files['source-concept-ids/ranges.json'] as
    | Array<Partial<SourceConceptIdRange>>
    | undefined
  const rawEntries = files['source-concept-ids/entries.json']
  if (rawRanges || rawEntries) {
    try {
      for (const r of rawRanges ?? []) {
        await storage.sourceConceptIdRanges.save({
          ...r, workspaceId, createdAt: r.createdAt ?? now, updatedAt: now,
        } as SourceConceptIdRange)
      }
      if (rawEntries) {
        const entries = parseSourceConceptIdEntries(
          rawEntries as Parameters<typeof parseSourceConceptIdEntries>[0], workspaceId,
        )
        if (entries.length > 0) await storage.sourceConceptIdEntries.saveBatch(entries)
      }
    } catch { /* leave the registry as-is */ }
  }

  // Precomputed suggestion scores (optional). Persist + push the fresh index so
  // the editor shows suggestions without a reload — same as the standalone path.
  if (scoresBytes && scoresBytes.byteLength > 0) {
    try {
      const scoresFile = new File([scoresBytes as BlobPart], `${targetId}.parquet`, {
        type: 'application/octet-stream',
      })
      if (isServerMode()) {
        const { persistScoresFileOnServer } = await import('@/lib/api/scores')
        await persistScoresFileOnServer(targetId, scoresFile)
      } else {
        const [{ persistScoresFile }, { validateScoresFile }] = await Promise.all([
          import('./scores-engine'),
          import('./scores-parser'),
        ])
        const validation = await validateScoresFile(scoresFile)
        if (validation.ok) await persistScoresFile(targetId, scoresFile)
      }
      const { useSuggestionScoresStore } = await import('@/stores/suggestion-scores-store')
      await useSuggestionScoresStore.getState().importScores(targetId, scoresFile)
    } catch { /* leave the project without scores */ }
  }

  return true
}
