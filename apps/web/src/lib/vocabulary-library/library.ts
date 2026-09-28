/**
 * The workspace vocabulary library, one API for both modes.
 *
 * Server mode delegates to `/workspaces/{id}/vocabulary-library` (the server
 * rewrites the chosen vocabularies into partitions). Front-only, an import is a
 * hidden vocabulary database kept as-is, and the library data source records
 * which import owns each vocabulary — its views (engine.mountVocabularyLibrary)
 * read each vocabulary from its owner. See tables.ts.
 */
import type { DataSource, DatabaseConnectionConfig } from '@/types'
import { isServerMode } from '@/lib/api-client'
import { toLocalized } from '@/lib/localized'
import { useDataSourceStore } from '@/stores/data-source-store'
import {
  fetchImportState,
  fetchLibraryFromServer,
  inspectExportOnServer,
  removeVocabularyOnServer,
  startImportOnServer,
  uploadExportFiles,
  type ServerExportSource,
} from '@/lib/api/vocabulary-library'
import { ATHENA_SCHEMA_MAPPING } from './schema-mapping'
import { RELEASE_VOCABULARY_ID } from './tables'
import type { InspectedExport, LibraryVocabulary, VocabularyImportInventory } from './types'

function config(ds: DataSource): DatabaseConnectionConfig {
  return ds.connectionConfig as DatabaseConnectionConfig
}

export function findLibraryDataSource(dataSources: readonly DataSource[], workspaceId: string | undefined): DataSource | undefined {
  return dataSources.find((d) => d.workspaceId === workspaceId && d.isVocabularyReference && config(d).vocabularyLibrary)
}

/** Vocabulary databases imported per mapping project before the library
 *  existed, not yet part of it. */
export function legacyVocabularyDatabases(dataSources: readonly DataSource[], workspaceId: string | undefined): DataSource[] {
  return dataSources.filter((d) =>
    d.workspaceId === workspaceId && d.isVocabularyReference
    && !config(d).vocabularyLibrary && !config(d).vocabularyImport)
}

/** Front-only mount plan: each owning import with its vocabularies. The shared
 *  tables come from the most recent import. */
export function libraryMountPlan(library: DataSource, dataSources: readonly DataSource[]): {
  owners: { dataSourceId: string; vocabularies: string[]; ownsAll: boolean }[]
  sharedFromId: string | undefined
} {
  const byImport = new Map<string, string[]>()
  let latest: { id: string; at: string } | undefined
  for (const v of config(library).vocabularies ?? []) {
    if (!v.importDataSourceId) continue
    if (!dataSources.some((d) => d.id === v.importDataSourceId)) continue
    byImport.set(v.importDataSourceId, [...(byImport.get(v.importDataSourceId) ?? []), v.vocabularyId])
    if (!latest || v.importedAt > latest.at) latest = { id: v.importDataSourceId, at: v.importedAt }
  }
  const owners = [...byImport.entries()].map(([id, vocabularies]) => {
    const held = config(dataSources.find((d) => d.id === id)!).vocabularyImport?.vocabularies ?? []
    const owned = new Set(vocabularies)
    return { dataSourceId: id, vocabularies: vocabularies.sort(), ownsAll: held.length > 0 && held.every((h) => owned.has(h.vocabularyId)) }
  })
  return { owners, sharedFromId: latest?.id }
}

export async function ensureLibraryDataSource(workspaceId: string): Promise<DataSource> {
  const store = useDataSourceStore.getState()
  const existing = findLibraryDataSource(store.dataSources, workspaceId)
  if (existing) return existing
  const id = await store.addDataSource({
    name: toLocalized('Vocabularies'),
    description: toLocalized('The OHDSI vocabularies of the workspace.'),
    sourceType: 'database',
    connectionConfig: { engine: 'duckdb', vocabularyLibrary: true, vocabularies: [] },
    schemaMapping: ATHENA_SCHEMA_MAPPING,
    isVocabularyReference: true,
  })
  return useDataSourceStore.getState().dataSources.find((d) => d.id === id)!
}

export async function loadLibraryVocabularies(workspaceId: string): Promise<LibraryVocabulary[]> {
  if (isServerMode()) return (await fetchLibraryFromServer(workspaceId)).vocabularies
  const library = findLibraryDataSource(useDataSourceStore.getState().dataSources, workspaceId)
  return library ? config(library).vocabularies ?? [] : []
}

// --- Import --------------------------------------------------------------

export type ExportSource =
  | { kind: 'files'; files: File[] }
  | { kind: 'serverPath'; path: string }
  | { kind: 'database'; dataSourceId: string }

export interface PreparedImport {
  workspaceId: string
  inspected: InspectedExport
  sourceLabel: string
  /** Server mode: where the server reads the export. */
  serverSource?: ServerExportSource
  /** Front-only: the hidden vocabulary database holding the export. */
  importDataSourceId?: string
  /** Front-only: that database was created for this import (dropped if unused). */
  createdImport?: boolean
}

function folderOf(files: File[]): string {
  const roots = new Set(files.map((f) => ((f as File & { webkitRelativePath?: string }).webkitRelativePath || '').split('/')[0]).filter(Boolean))
  return roots.size === 1 ? [...roots][0] : `${files.length} files`
}

/** Read what an export holds, against the library. Front-only this creates the
 *  import's database, which `discardPreparedImport` drops if left unused. */
export async function prepareImport(
  workspaceId: string,
  source: ExportSource,
  onUpload?: (done: number, total: number) => void,
): Promise<PreparedImport> {
  const store = useDataSourceStore.getState()
  const sourceLabel = source.kind === 'files'
    ? folderOf(source.files)
    : source.kind === 'serverPath'
      ? source.path
      : store.dataSources.find((d) => d.id === source.dataSourceId)?.alias ?? 'database'

  if (isServerMode()) {
    const serverSource: ServerExportSource = source.kind === 'files'
      ? await uploadExportFiles(source.files, onUpload)
      : source.kind === 'serverPath'
        ? { serverPath: source.path }
        : { dataSourceId: source.dataSourceId }
    return { workspaceId, sourceLabel, serverSource, inspected: await inspectExportOnServer(workspaceId, serverSource) }
  }

  if (source.kind === 'serverPath') throw new Error('A server folder needs server mode.')
  const createdImport = source.kind === 'files'
  const importDataSourceId = source.kind === 'files'
    ? await store.addDataSource({
        name: toLocalized(`ATHENA — ${sourceLabel}`),
        description: toLocalized('An ATHENA export, read by the workspace vocabulary library.'),
        sourceType: 'database',
        connectionConfig: { engine: 'duckdb' },
        schemaMapping: ATHENA_SCHEMA_MAPPING,
        files: source.files,
        isVocabularyReference: true,
      })
    : source.dataSourceId
  try {
    const inventory = await inspectImportDatabase(importDataSourceId, sourceLabel)
    const library = findLibraryDataSource(useDataSourceStore.getState().dataSources, workspaceId)
    const held = new Map((library ? config(library).vocabularies ?? [] : []).map((v) => [v.vocabularyId, v]))
    return {
      workspaceId,
      sourceLabel,
      importDataSourceId,
      createdImport,
      inspected: {
        release: inventory.release,
        tables: [],
        vocabularies: inventory.vocabularies.map((v) => ({
          ...v,
          inLibrary: held.has(v.vocabularyId),
          libraryVersion: held.get(v.vocabularyId)?.vocabularyVersion ?? null,
        })),
      },
    }
  } catch (err) {
    if (createdImport) await store.removeDataSource(importDataSourceId, { deleteData: true }).catch(() => {})
    throw err
  }
}

async function inspectImportDatabase(dataSourceId: string, source: string): Promise<VocabularyImportInventory> {
  const { queryDataSource } = await import('@/lib/duckdb/engine')
  const counts = await queryDataSource(dataSourceId,
    'SELECT CAST(vocabulary_id AS VARCHAR) AS id, COUNT(*) AS n FROM concept WHERE vocabulary_id IS NOT NULL GROUP BY 1 ORDER BY 1')
  let meta: Record<string, unknown>[] = []
  try {
    meta = await queryDataSource(dataSourceId,
      'SELECT CAST(vocabulary_id AS VARCHAR) AS id, CAST(vocabulary_name AS VARCHAR) AS name, CAST(vocabulary_version AS VARCHAR) AS version FROM vocabulary')
  } catch { /* an export without VOCABULARY: no versions to compare */ }
  const byId = new Map(meta.map((r) => [String(r.id), r]))
  const release = byId.get(RELEASE_VOCABULARY_ID)?.version
  return {
    release: release != null ? String(release) : null,
    source,
    importedAt: new Date().toISOString(),
    vocabularies: counts.map((r) => {
      const m = byId.get(String(r.id))
      return {
        vocabularyId: String(r.id),
        vocabularyName: m?.name != null ? String(m.name) : null,
        vocabularyVersion: m?.version != null ? String(m.version) : null,
        conceptCount: Number(r.n),
      }
    }),
  }
}

/** Drop the import database a preview created, when it is not imported. */
export async function discardPreparedImport(prepared: PreparedImport): Promise<void> {
  if (!prepared.createdImport || !prepared.importDataSourceId) return
  await useDataSourceStore.getState().removeDataSource(prepared.importDataSourceId, { deleteData: true }).catch(() => {})
}

export interface ImportProgress {
  step: string
  done: number
  total: number
}

/** Bring `vocabularies` of the prepared export into the library, replacing the
 *  versions it holds. */
export async function runImport(
  prepared: PreparedImport,
  vocabularies: string[],
  onProgress?: (p: ImportProgress) => void,
): Promise<void> {
  const { workspaceId } = prepared
  const library = await ensureLibraryDataSource(workspaceId)
  const store = useDataSourceStore.getState()

  if (isServerMode()) {
    let state = await startImportOnServer(workspaceId, prepared.serverSource!, vocabularies)
    while (state.status === 'running') {
      onProgress?.({ step: state.step, done: state.done, total: state.total })
      await new Promise((r) => setTimeout(r, 1000))
      state = await fetchImportState(workspaceId, state.id)
    }
    if (state.status === 'error') throw new Error(state.error ?? 'Import failed')
    await store.loadDataSources(true)
    return
  }

  const importId = prepared.importDataSourceId!
  const now = new Date().toISOString()
  const chosen = new Set(vocabularies)
  const inventory: VocabularyImportInventory = {
    release: prepared.inspected.release,
    source: prepared.sourceLabel,
    importedAt: now,
    vocabularies: prepared.inspected.vocabularies.map(({ vocabularyId, vocabularyName, vocabularyVersion, conceptCount }) =>
      ({ vocabularyId, vocabularyName, vocabularyVersion, conceptCount })),
  }
  const importDs = store.dataSources.find((d) => d.id === importId)!
  await store.updateDataSource(importId, { connectionConfig: { ...config(importDs), vocabularyImport: inventory } })
  const held = (config(library).vocabularies ?? []).filter((v) => !chosen.has(v.vocabularyId))
  const added: LibraryVocabulary[] = inventory.vocabularies.filter((v) => chosen.has(v.vocabularyId)).map((v) => ({
    ...v,
    release: inventory.release,
    source: inventory.source,
    importedAt: now,
    importDataSourceId: importId,
  }))
  await setLibraryVocabularies(library, [...held, ...added])
}

async function setLibraryVocabularies(library: DataSource, vocabularies: LibraryVocabulary[]): Promise<void> {
  const store = useDataSourceStore.getState()
  const sorted = [...vocabularies].sort((a, b) => (a.vocabularyId < b.vocabularyId ? -1 : 1))
  const fresh = store.dataSources.find((d) => d.id === library.id) ?? library
  await store.updateDataSource(library.id, { connectionConfig: { ...config(fresh), vocabularies: sorted } })
  // An import that owns nothing any more is only taking space.
  const owners = new Set(sorted.map((v) => v.importDataSourceId))
  for (const ds of useDataSourceStore.getState().dataSources) {
    if (ds.workspaceId === library.workspaceId && config(ds).vocabularyImport && !owners.has(ds.id)) {
      await store.removeDataSource(ds.id, { deleteData: true }).catch(() => {})
    }
  }
  await store.invalidateMount(library.id)
}

export async function removeVocabulary(workspaceId: string, vocabularyId: string): Promise<void> {
  if (isServerMode()) {
    await removeVocabularyOnServer(workspaceId, vocabularyId)
    await useDataSourceStore.getState().loadDataSources(true)
    return
  }
  const library = findLibraryDataSource(useDataSourceStore.getState().dataSources, workspaceId)
  if (!library) return
  await setLibraryVocabularies(library, (config(library).vocabularies ?? []).filter((v) => v.vocabularyId !== vocabularyId))
}
