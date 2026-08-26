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
import { ENTITY_MANIFEST } from '@linkr/format'
import { readEntityDocsFrom } from '@/lib/entity-docs-pull'
import {
  gitPullPreview,
  gitPullFile,
  gitSetSyncState,
  type GitPullSide,
  type SourceConceptsDiff,
} from '@/lib/api/git'
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
  /** Remote `source-concept-ids/` files — merged monotonically on apply, with no
   *  user choice (see pull-source-concept-ids.ts). */
  remoteRegistry: { ranges: string | null | undefined; entries: string | null | undefined }
  /** Row-level source-concept diff by (vocabulary, code), computed server-side.
   *  `keyed: false` means a side was unparseable → whole-file choice only. */
  sourceConceptsDiff: SourceConceptsDiff | undefined
}

/** Parse a managed JSON file from a preview side; [] / {} on absence or bad JSON. */
function parseJson<T>(side: GitPullSide, name: string, fallback: T, ...alsoTry: string[]): T {
  // Falling back silently is right for a genuinely absent file, but it also hid
  // the manifest rename: a repo whose metadata moved to entity.json read as
  // "no metadata changes" rather than as an error, so the names are all tried.
  const raw = [name, ...alsoTry].map((n) => side.files[n]).find((v) => v !== undefined)
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
 * Is there anything to take from the remote source list?
 *
 * Prefers the server's ROW diff, which compares LOCAL to REMOTE directly. The
 * oid test answers a different question — "did the remote move since our anchor?"
 * — and on its own hid the common case where the remote never moved but our local
 * list drifted from it: the file then never appeared in the pull at all.
 *
 * The oid test remains the fallback for a CSV that could not be keyed (unsmudged
 * LFS pointer, missing identity column): there are no rows to compare, so a moved
 * blob is the only evidence of a change we have.
 */
export function sourceConceptsChanged(
  rowDiff: SourceConceptsDiff | undefined,
  changedByOid: boolean,
): boolean {
  if (rowDiff?.keyed) return rowDiff.added > 0 || rowDiff.removed > 0 || rowDiff.modified > 0
  return changedByOid
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
  const baseProject = parseJson<Partial<MappingProject>>(preview.base, ENTITY_MANIFEST, {}, 'project.json')
  const remoteProject = parseJson<Partial<MappingProject>>(preview.remote, ENTITY_MANIFEST, {}, 'project.json')

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

  // Source concepts: whole-list block choice — see sourceConceptsChanged.
  const remoteCsv = preview.remote.stats['source-concepts.csv']
  const localCsvCount = localProject?.fileSourceData?.totalRowCount ?? 0
  const sourceConcepts = listDiffStat(
    localCsvCount,
    remoteCsv?.rowCount ?? 0,
    sourceConceptsChanged(
      preview.sourceConceptsDiff,
      listChangedByOid(preview, 'source-concepts.csv'),
    ),
    { remoteByteSize: remoteCsv?.byteSize, remoteLfs: remoteCsv?.lfs },
  )

  return {
    merge: { mappings, metadata, sourceConcepts },
    remoteHead: preview.remoteHead,
    localMappings,
    localProject: localProject ?? undefined,
    sourceConceptsDiff: preview.sourceConceptsDiff,
    remoteRegistry: {
      ranges: preview.remote.files['source-concept-ids/ranges.json'],
      entries: preview.remote.files['source-concept-ids/entries.json'],
    },
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

// --- Applying the resolved pull -------------------------------------------

export interface PullResolution {
  /** Clean remote changes (add/update/delete) the user kept. */
  mappings: MappingChange[]
  /** For each conflicted mapping key: 'remote' (take theirs) or 'local' (keep mine). */
  mappingConflictChoices: Record<string, 'remote' | 'local'>
  metadataUpdates: { field: string; value: unknown }[]
  metadataConflictChoices: Record<string, 'remote' | 'local'>
  takeRemoteSourceConcepts: boolean
  /** `vocab|code` pairs whose remote change the user refused. The applier rebuilds
   *  the CSV around them, so a per-row refusal actually holds. */
  declinedSourceConcepts?: ReadonlySet<string>
  /**
   * The user accepted EVERYTHING the plan offered.
   *
   * Decides which cursor advances: a complete pull moves the content anchor (we
   * hold this commit), a partial-but-decided one moves only the review cursor
   * (we deliberated, but kept our own version of some items — so the 3-way base
   * must stay put or it would absorb what was declined).
   */
  complete: boolean
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

  // 4) Heavy whole-list family — fetch the remote bytes and write them.
  if (resolution.takeRemoteSourceConcepts) {
    await replaceSourceConcepts(
      storage,
      projectId,
      branch,
      prepared.localProject,
      resolution.declinedSourceConcepts ?? new Set(),
    )
  }

  // 4b) Badge allocation registry — always merged, never offered as a choice: the
  //     merge is monotone (local id wins, nextId = max), so declining it could only
  //     leave the two instances' allocations diverged.
  const workspaceId = prepared.localProject?.workspaceId
  if (workspaceId) {
    const { pullSourceConceptIds } = await import('./pull-source-concept-ids')
    await pullSourceConceptIds(storage, workspaceId, prepared.remoteRegistry)
  }

  // 5) Advance the cursors. A complete pull moves both (we hold this commit's
  //    content); a partial one moves only the review cursor, so the banner clears
  //    and the push unblocks while the 3-way base stays honest about what we hold.
  if (prepared.remoteHead) {
    await gitSetSyncState(
      'mapping-projects',
      projectId,
      branch,
      prepared.remoteHead,
      /* reviewedOnly */ !resolution.complete,
    )
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

/**
 * Write the remote source list into the project.
 *
 * `declinedKeys` are `vocab|code` pairs the user refused. The applier does not
 * take the remote CSV verbatim in that case: it rebuilds the file, keeping the
 * local row wherever the remote change was declined. That is what makes a
 * per-row choice honest rather than decorative — the CSV is still written as one
 * blob, but the blob is the user's resolution, not the remote's.
 */
async function replaceSourceConcepts(
  storage: ReturnType<typeof getStorage>,
  projectId: string,
  branch: string,
  localProject: MappingProject | undefined,
  declinedKeys: ReadonlySet<string>,
): Promise<void> {
  const bytes = await gitPullFile('mapping-projects', projectId, 'source-concepts.csv', branch)
  let csv = new TextDecoder().decode(bytes)

  if (declinedKeys.size > 0) {
    const localCsv = decodeLocalSourceCsv(localProject)
    const { mergeSourceConceptsCsv } = await import('./source-concepts-diff')
    const merged = mergeSourceConceptsCsv(localCsv, csv, declinedKeys, sourceColumnMapping(localProject))
    // A merge we couldn't compute (unkeyable side) must not silently fall back to
    // "take everything" — that would apply changes the user explicitly refused.
    if (merged == null) throw new Error('Cannot apply a partial source-concept pull on an uncomparable file')
    csv = merged
  }

  const { restoreFileSourceDataFromCsv } = await import('./export')
  // Reuse the import path's reconstruction of fileSourceData from a CSV string.
  const p = { ...(localProject ?? { id: projectId }), sourceType: 'file', fileSourceData: localProject?.fileSourceData ?? { fileName: 'source-concepts.csv', columnMapping: {}, columns: [], rows: [] } } as MappingProject
  restoreFileSourceDataFromCsv(p, csv)
  await storage.mappingProjects.update(projectId, { fileSourceData: p.fileSourceData })
}

/** The local source CSV text, from the raw buffer the project keeps. */
function decodeLocalSourceCsv(project: MappingProject | undefined): string | null {
  const buf = project?.fileSourceData?.rawFileBuffer
  if (!buf) return null
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return new TextDecoder().decode(bytes)
}

/** The project's declared identity columns, for keying its own CSV. */
function sourceColumnMapping(project: MappingProject | undefined) {
  const m = project?.fileSourceData?.columnMapping
  return m ? { terminologyColumn: m.terminologyColumn, conceptCodeColumn: m.conceptCodeColumn } : undefined
}

