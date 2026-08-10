/**
 * Pull orchestration for a mapping project: fetch the server preview (BASE +
 * REMOTE managed files), read LOCAL from the DB, and run the pure 3-way merge
 * (merge.ts) to produce the change plan the resolution UI renders.
 *
 * This is the glue (I/O + parsing); all the "what changed / is it a conflict"
 * logic lives in merge.ts so it stays unit-testable without a server.
 */
import type { ConceptMapping, MappingProject } from '@/types'
import { getStorage } from '@/lib/storage'
import { readEntityDocsFrom } from '@/lib/entity-docs-pull'
import { gitPullPreview, gitPullFile, gitSetSyncState, type GitPullSide } from '@/lib/api/git'
import {
  mergeMappings,
  mergeMetadata,
  mappingKey,
  listDiffStat,
  type MappingChange,
  type MappingProjectMerge,
} from './merge'

export interface PreparedPull {
  merge: MappingProjectMerge
  remoteHead: string | null
  /** Local mappings, kept so apply can resolve a merge key back to its local id. */
  localMappings: ConceptMapping[]
  localProject: MappingProject | undefined
}

/** Parse a managed JSON file from a preview side; [] / {} on absence or bad JSON. */
function parseJson<T>(side: GitPullSide, name: string, fallback: T): T {
  const raw = side.files[name]
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Did the remote change a whole-list file since BASE? Compare content oids — for
 *  an LFS file the oid is the pointer's, so this is reliable without smudging. If
 *  BASE is absent (never synced there) fall back to "present remotely = changed". */
function listChangedByOid(preview: { base: GitPullSide; remote: GitPullSide }, name: string): boolean {
  const b = preview.base.stats[name]
  const r = preview.remote.stats[name]
  if (!r?.present) return false // nothing remote → nothing to take
  if (!b?.present) return true // remote has it, base didn't → a change to pull
  return b.oid !== r.oid
}

/**
 * Build the full merge plan for a mapping project. `projectId` is the LOCAL
 * entity; `branch` optionally overrides the linked branch.
 */
export async function prepareMappingProjectPull(projectId: string, branch?: string): Promise<PreparedPull> {
  const storage = getStorage()
  const [preview, localMappings, localProject] = await Promise.all([
    gitPullPreview('mapping-projects', projectId, branch),
    storage.conceptMappings.getByProject(projectId),
    storage.mappingProjects.getById(projectId),
  ])

  const baseMappings = parseJson<ConceptMapping[]>(preview.base, 'mappings.json', [])
  const remoteMappings = parseJson<ConceptMapping[]>(preview.remote, 'mappings.json', [])
  const baseProject = parseJson<Partial<MappingProject>>(preview.base, 'project.json', {})
  const remoteProject = parseJson<Partial<MappingProject>>(preview.remote, 'project.json', {})

  const mappings = mergeMappings(baseMappings, remoteMappings, localMappings)
  // README/LICENSE are files, not project.json fields (the export strips the readme
  // and keeps only the licence ID there). Fold them back onto each side so they go
  // through the SAME per-field 3-way as name/description: an edit on both sides
  // becomes a conflict the user resolves, rather than a silently lost local README.
  const metadata = mergeMetadata(
    withDocs(baseProject, preview.base.files),
    withDocs(remoteProject, preview.remote.files),
    localProject ?? {},
  )

  // Source concepts: whole-list block choice — "changed" iff the remote blob oid
  // differs from BASE (reliable for LFS; a row count would need smudging). The
  // remote row count/size is informational for the UI (may be absent for LFS).
  const remoteCsv = preview.remote.stats['source-concepts.csv']
  const localCsvCount = localProject?.fileSourceData?.totalRowCount ?? 0
  const sourceConcepts = listDiffStat(
    localCsvCount,
    remoteCsv?.rowCount ?? 0,
    listChangedByOid(preview, 'source-concepts.csv'),
    { remoteByteSize: remoteCsv?.byteSize, remoteLfs: remoteCsv?.lfs },
  )

  // Scores: remote-wins block, changed iff the remote parquet oid differs from BASE.
  const remoteScores = preview.remote.stats['similarity-scores.parquet']
  const localScores = await getLocalScoreCount(projectId)
  const scores = listDiffStat(
    localScores,
    remoteScores?.rowCount ?? 0,
    listChangedByOid(preview, 'similarity-scores.parquet'),
    { remoteByteSize: remoteScores?.byteSize, remoteLfs: remoteScores?.lfs },
  )

  return {
    merge: { mappings, metadata, sourceConcepts, scores },
    remoteHead: preview.remoteHead,
    localMappings,
    localProject: localProject ?? undefined,
  }
}

/**
 * A parsed side's project metadata with its docs folded in.
 *
 * `readme` and `license` reach the client as README*.md / LICENSE.md text, and the
 * licence ID (not its text) lives in project.json — `readEntityDocsFrom` recombines
 * the two, exactly as the clone-based pulls do. Fields the side does not carry are
 * left absent so `mergeMetadata` reads them as unchanged rather than as cleared.
 */
function withDocs(
  meta: Partial<MappingProject>,
  files: Record<string, string | null>,
): Partial<MappingProject> {
  const parsed: Record<string, unknown> = {}
  for (const [path, text] of Object.entries(files)) {
    if (typeof text === 'string') parsed[path] = text
  }
  const docs = readEntityDocsFrom(parsed, meta as { license?: { id?: string; name?: string } })
  // `license` is REPLACED, not merged in: project.json holds only the id, and
  // leaving that bare id in place would compare an {id} against a full
  // {id,text} licence and report a change on every pull. When the side has no
  // LICENSE.md the licence is genuinely absent there.
  return {
    ...meta,
    ...(docs.readme ? { readme: docs.readme } : {}),
    license: docs.license,
  }
}

/** Best-effort local scores count — the store may not expose it, so 0 is fine
 *  (the count is informational; the merge choice is "take remote"). */
async function getLocalScoreCount(_projectId: string): Promise<number> {
  return 0
}

// --- Applying the resolved pull -------------------------------------------

export interface PullResolution {
  /** Clean remote changes (add/update/delete) the user kept. */
  mappings: MappingChange[]
  /** For each conflicted mapping key: 'remote' (take theirs) or 'local' (keep mine). */
  mappingConflictChoices: Record<string, 'remote' | 'local'>
  metadataUpdates: { field: string; value: unknown }[]
  metadataConflictChoices: Record<string, 'remote' | 'local'>
  takeRemoteSourceConcepts: boolean
  takeRemoteScores: boolean
}

/**
 * Apply a resolved pull to the local DB, then advance the sync anchor to the
 * remote head. Writes go through the normal storage APIs (so server + front-only
 * behave identically). Order: mappings → metadata → heavy families → anchor.
 */
export async function applyMappingProjectPull(
  projectId: string,
  branch: string,
  prepared: PreparedPull,
  resolution: PullResolution,
): Promise<void> {
  const storage = getStorage()
  // Resolve a merge key → local mapping id (local ids differ from remote ids).
  const localByKey = new Map(prepared.localMappings.map((m) => [mappingKey(m), m]))

  // 1) Clean mapping changes the user kept.
  const toCreate: ConceptMapping[] = []
  for (const change of resolution.mappings) {
    await applyMappingChange(storage, projectId, change, localByKey, toCreate)
  }

  // 2) Conflicted mappings resolved as 'remote' (local = keep mine, no-op).
  for (const change of prepared.merge.mappings.filter((c) => c.type === 'conflict')) {
    if (resolution.mappingConflictChoices[change.key] !== 'remote') continue
    await applyMappingChange(storage, projectId, change, localByKey, toCreate, /*fromConflict*/ true)
  }
  if (toCreate.length > 0) await storage.conceptMappings.createBatch(toCreate)

  // 3) Metadata: clean updates + conflicts resolved as 'remote'.
  const metaChanges: Record<string, unknown> = {}
  for (const u of resolution.metadataUpdates) metaChanges[u.field] = u.value
  for (const c of prepared.merge.metadata.conflicts) {
    if (resolution.metadataConflictChoices[c.field] === 'remote') metaChanges[c.field] = c.remote
  }
  if (Object.keys(metaChanges).length > 0) {
    await storage.mappingProjects.update(projectId, metaChanges as Partial<MappingProject>)
  }

  // 4) Heavy whole-list families — fetch the remote bytes and write them.
  if (resolution.takeRemoteSourceConcepts) {
    await replaceSourceConcepts(storage, projectId, branch, prepared.localProject)
  }
  if (resolution.takeRemoteScores) {
    await replaceScores(projectId, branch)
  }

  // 5) Advance the anchor: we're now in sync with the remote head.
  if (prepared.remoteHead) {
    await gitSetSyncState('mapping-projects', projectId, branch, prepared.remoteHead)
  }
}

/** Apply one mapping change (add/update/delete) to the DB. `toCreate` collects
 *  adds for a single batch insert. New rows get a fresh local id + projectId. */
async function applyMappingChange(
  storage: ReturnType<typeof getStorage>,
  projectId: string,
  change: MappingChange,
  localByKey: Map<string, ConceptMapping>,
  toCreate: ConceptMapping[],
  fromConflict = false,
): Promise<void> {
  const localId = localByKey.get(change.key)?.id
  if (change.type === 'add' || (fromConflict && change.remote && !localId)) {
    if (change.remote) toCreate.push({ ...change.remote, id: crypto.randomUUID(), projectId })
    return
  }
  if (change.type === 'delete' || (fromConflict && !change.remote)) {
    if (localId) await storage.conceptMappings.delete(localId)
    return
  }
  // update (or conflict→remote where a local row exists): overwrite content fields.
  if (change.remote && localId) {
    const { id: _id, projectId: _p, createdAt: _c, ...rest } = change.remote
    await storage.conceptMappings.update(localId, rest)
  } else if (change.remote) {
    toCreate.push({ ...change.remote, id: crypto.randomUUID(), projectId })
  }
}

async function replaceSourceConcepts(
  storage: ReturnType<typeof getStorage>,
  projectId: string,
  branch: string,
  localProject: MappingProject | undefined,
): Promise<void> {
  const bytes = await gitPullFile('mapping-projects', projectId, 'source-concepts.csv', branch)
  const csv = new TextDecoder().decode(bytes)
  const { restoreFileSourceDataFromCsv } = await import('./export')
  // Reuse the import path's reconstruction of fileSourceData from a CSV string.
  const p = { ...(localProject ?? { id: projectId }), sourceType: 'file', fileSourceData: localProject?.fileSourceData ?? { fileName: 'source-concepts.csv', columnMapping: {}, columns: [], rows: [] } } as MappingProject
  restoreFileSourceDataFromCsv(p, csv)
  await storage.mappingProjects.update(projectId, { fileSourceData: p.fileSourceData })
}

async function replaceScores(projectId: string, branch: string): Promise<void> {
  const bytes = await gitPullFile('mapping-projects', projectId, 'similarity-scores.parquet', branch)
  if (!bytes || bytes.byteLength === 0) return
  const file = new File([bytes as BlobPart], `${projectId}.parquet`, { type: 'application/octet-stream' })
  const { useSuggestionScoresStore } = await import('@/stores/suggestion-scores-store')
  await useSuggestionScoresStore.getState().importScores(projectId, file)
}
