import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { isServerMode } from '@/lib/api-client'
import { createFromDdlOnServer, fetchDataSourceSchema, retestConnectionOnServer, testConnectionOnServer, uploadDataSourceFile } from '@/lib/api/data-sources'
import { DB_ERROR_NO_DATA_ON_IMPORT } from '@/lib/entity-io'
import * as engine from '@/lib/duckdb/engine'
import { generateAlias, ensureUniqueAlias } from '@/lib/duckdb/engine'
import { sanitizeSchemaMapping } from '@/lib/schema-helpers'
import { localized } from '@/lib/localized'
import { useAppStore, stampAuthored, stampLineage } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useConnectionStore } from '@/stores/connection-store'
import type {
  DataSource,
  DatabaseConnectionConfig,
  DataSourceType,
  ConnectionConfig,
  DataSourceStatus,
  SchemaMapping,
  SchemaSource,
  StoredFile,
  StoredFileHandle,
  ProjectBadge,
  LocalizedString,
} from '@/types'

// --- Active data source persistence (localStorage) ---

const ACTIVE_DS_KEY = 'linkr-active-datasources'

function loadActiveDataSourceIds(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ACTIVE_DS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function saveActiveDataSourceIds(ids: Record<string, string>): void {
  localStorage.setItem(ACTIVE_DS_KEY, JSON.stringify(ids))
}

interface DataSourceState {
  dataSources: DataSource[]
  dataSourcesLoaded: boolean

  loadDataSources: () => Promise<void>

  /** Get data sources for a specific workspace. */
  getWorkspaceSources: (workspaceId: string) => DataSource[]
  getProjectSources: (projectUid: string) => DataSource[]
  getFirstMappedSource: (projectUid: string) => DataSource | undefined

  /** Map projectUid → active dataSourceId. */
  activeDataSourceIds: Record<string, string>
  /** Set (or clear) the active data source for a project. */
  setActiveDataSource: (projectUid: string, dataSourceId: string | null) => void
  /** Get the active data source for a project, with fallback to first mapped source. */
  getActiveSource: (projectUid: string) => DataSource | undefined

  addDataSource: (source: {
    name: LocalizedString
    description: LocalizedString
    sourceType: DataSourceType
    connectionConfig: ConnectionConfig
    schemaMapping?: SchemaMapping
    /** Which published schema the mapping was copied from. The mapping is inlined
     *  into the row, so this is the only record of where it came from. */
    schemaSource?: SchemaSource
    files?: File[]
    /** File System Access API handles for zero-copy import (Chrome/Edge). */
    fileHandles?: { fileName: string; handle: FileSystemFileHandle; fileSize: number }[]
    /** Mark as vocabulary reference (hidden from database pages). */
    isVocabularyReference?: boolean
    /** Override auto-generated alias (slug). */
    alias?: string
    badges?: ProjectBadge[]
    version?: string
  }) => Promise<string>

  updateDataSource: (id: string, changes: Partial<DataSource>) => Promise<void>
  /** Re-validate a server-mode external source (Postgres) using its stored
   *  credentials, refreshing status + stats. No-op in front-only mode. */
  retestDataSource: (id: string) => Promise<void>
  removeDataSource: (id: string) => Promise<void>
  testConnection: (id: string) => Promise<void>
  /** Unmount a data source from DuckDB and set status to 'disconnected'. */
  disconnectDataSource: (id: string) => Promise<void>
  mountProjectSources: (projectUid: string) => Promise<void>
  /** Re-request File System Access permissions for a disconnected data source. */
  reconnectDataSource: (id: string) => Promise<void>
  /** Ensure a data source is mounted in DuckDB (mount if needed). */
  ensureMounted: (id: string) => Promise<void>

  /**
   * Create an empty database from a schema preset's DDL.
   * Creates an in-memory DuckDB schema with the DDL tables.
   * Returns the new data source ID.
   */
  createEmptyDatabase: (source: {
    name: LocalizedString
    description: LocalizedString
    schemaMapping: SchemaMapping
    ddl: string
    alias?: string
  }) => Promise<string>
}

/** Timeout for DuckDB mount operations (ms). */
const MOUNT_TIMEOUT = 30_000
/** Timeout for DuckDB stat computation (ms). */
const STATS_TIMEOUT = 15_000

/** Wrap a promise with a timeout to avoid hanging on DuckDB worker issues. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms),
    ),
  ])
}

/** Reset DuckDB worker if the error looks like a timeout/worker crash. */
function handleDuckDBError(err: unknown): void {
  if (err instanceof Error && err.message.startsWith('Timeout after')) {
    console.warn('[DuckDB] Worker appears hung, resetting…')
    engine.resetDuckDB()
    mountedSources.clear()
  }
}

/** Track which data sources are currently mounted in DuckDB. */
const mountedSources = new Set<string>()

/** Track in-flight mount promises to avoid concurrent mounts of the same source. */
const mountingPromises = new Map<string, Promise<void>>()

/** Track data sources currently being processed (mounting, testing, reconnecting). */
const busySources = new Set<string>()

/** Guard against concurrent loadDataSources calls. */
let loadingPromise: Promise<void> | null = null

export const useDataSourceStore = create<DataSourceState>((set, get) => ({
  dataSources: [],
  dataSourcesLoaded: false,

  loadDataSources: async () => {
    if (loadingPromise) return loadingPromise
    loadingPromise = (async () => {
      try {
        const all = await getStorage().dataSources.getAll()
        // Migrate: assign alias to data sources that don't have one yet
        const existingAliases = all.filter((ds) => ds.alias).map((ds) => ds.alias)
        // Migrate: assign workspaceId to data sources that don't have one
        const activeWsId = useWorkspaceStore.getState().activeWorkspaceId
        for (const ds of all) {
          let dirty = false
          if (!ds.alias) {
            const base = generateAlias(localized(ds.name, 'en'))
            ds.alias = ensureUniqueAlias(base, existingAliases)
            existingAliases.push(ds.alias)
            dirty = true
          }
          if (!ds.workspaceId && activeWsId) {
            ds.workspaceId = activeWsId
            dirty = true
          }
          if (dirty) getStorage().dataSources.update(ds.id, { alias: ds.alias, workspaceId: ds.workspaceId })
          engine.registerAlias(ds.id, ds.alias)
          // Validated on the way OUT of storage, not only on the way in: a row
          // can be written by an imported ZIP, a cloned repo or the seed loader
          // without passing through this store, and every warehouse query
          // interpolates these table/column names straight into SQL. This array
          // is what those queries read, so this is the one gate they all share.
          if (ds.schemaMapping) ds.schemaMapping = sanitizeSchemaMapping(ds.schemaMapping)
        }
        set({ dataSources: all, dataSourcesLoaded: true })
      } finally {
        loadingPromise = null
      }
    })()
    return loadingPromise
  },

  getWorkspaceSources: (workspaceId: string) => {
    return get().dataSources.filter((ds) => ds.workspaceId === workspaceId)
  },

  getProjectSources: (projectUid: string) => {
    const linkedIds = useAppStore.getState().getProjectLinkedDataSourceIds(projectUid)
    return get().dataSources.filter((ds) => linkedIds.includes(ds.id))
  },

  getFirstMappedSource: (projectUid: string) => {
    const linkedIds = useAppStore.getState().getProjectLinkedDataSourceIds(projectUid)
    return get().dataSources.find(
      (ds) => linkedIds.includes(ds.id) && !!ds.schemaMapping?.patientTable && ds.status === 'connected',
    )
  },

  activeDataSourceIds: loadActiveDataSourceIds(),

  setActiveDataSource: (projectUid, dataSourceId) => {
    set((s) => {
      const next = { ...s.activeDataSourceIds }
      if (dataSourceId) {
        next[projectUid] = dataSourceId
      } else {
        delete next[projectUid]
      }
      saveActiveDataSourceIds(next)
      return { activeDataSourceIds: next }
    })
    // Sync IDE connection dropdown
    useConnectionStore.getState().setActiveConnection(dataSourceId)
  },

  getActiveSource: (projectUid) => {
    const { dataSources, activeDataSourceIds } = get()
    const activeId = activeDataSourceIds[projectUid]
    if (activeId) {
      const ds = dataSources.find((d) => d.id === activeId && d.status === 'connected')
      if (ds) return ds
    }
    // Fallback: first connected linked source with schema mapping
    const linkedIds = useAppStore.getState().getProjectLinkedDataSourceIds(projectUid)
    return dataSources.find(
      (ds) => linkedIds.includes(ds.id) && !!ds.schemaMapping?.patientTable && ds.status === 'connected',
    )
  },

  addDataSource: async (source) => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    const useFileHandles = !!(source.fileHandles && source.fileHandles.length > 0)
    const connectionConfig = { ...source.connectionConfig } as Record<string, unknown>

    // --- Path A: File System Access handles (zero-copy) ---
    const storedHandles: StoredFileHandle[] = []
    const storedFiles: StoredFile[] = []
    // Server mode: files streamed to the server *after* the source row is created.
    let serverFilesToUpload: File[] | null = null

    // FS Access handles are client-only; never persist them in server mode
    // (the picker is hidden there, but guard the write defensively).
    if (useFileHandles && source.fileHandles && !isServerMode()) {
      for (const fh of source.fileHandles) {
        const stored: StoredFileHandle = {
          id: crypto.randomUUID(),
          dataSourceId: id,
          fileName: fh.fileName,
          fileSize: fh.fileSize,
          handle: fh.handle,
          createdAt: now,
        }
        storedHandles.push(stored)
        await getStorage().fileHandles.create(stored)
      }
      connectionConfig.useFileHandles = true
      if (storedHandles.length === 1) {
        connectionConfig.fileId = storedHandles[0].id
      } else {
        connectionConfig.fileIds = storedHandles.map((h) => h.id)
        connectionConfig.fileNames = storedHandles.map((h) => h.fileName)
      }
    }
    // --- Path B: Full copy to IndexedDB (classic) ---
    else if (source.files && source.files.length > 0) {
      const fileNameOf = (f: File) =>
        (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name

      if (isServerMode()) {
        // Server mode: the actual upload happens AFTER the source row exists on
        // the server (see below) — /files/import 404s otherwise. Here we only
        // set the config markers (single file vs folder), computable up front.
        const names = source.files.map(fileNameOf)
        if (names.length === 1 && source.sourceType === 'database') {
          connectionConfig.fileId = crypto.randomUUID()
        } else if (names.length > 0) {
          connectionConfig.fileIds = names.map(() => crypto.randomUUID())
          connectionConfig.fileNames = names
        }
        serverFilesToUpload = source.files
      } else {
        for (const file of source.files) {
          const data = await file.arrayBuffer()
          const fileName = fileNameOf(file)

          // Content-hash dedup: scoped to vocabulary reference imports for now. The same
          // OHDSI Athena vocabulary used across multiple mapping projects is a common case
          // and would otherwise pile up gigabytes of duplicate bytes in IDB.
          let contentHash: string | undefined
          let dedupRef: string | undefined
          let bytesToStore: ArrayBuffer = data
          if (source.isVocabularyReference) {
            const hashBuffer = await crypto.subtle.digest('SHA-256', data)
            contentHash = Array.from(new Uint8Array(hashBuffer))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('')
            const canonical = await getStorage().files.findByHash(contentHash)
            if (canonical) {
              dedupRef = canonical.id
              // Store an empty buffer — readers follow the dedupRef to fetch real bytes.
              bytesToStore = new ArrayBuffer(0)
            }
          }

          const storedFile: StoredFile = {
            id: crypto.randomUUID(),
            dataSourceId: id,
            fileName,
            fileSize: file.size,
            data: bytesToStore,
            createdAt: now,
            ...(contentHash ? { contentHash } : {}),
            ...(dedupRef ? { dedupRef } : {}),
          }
          storedFiles.push(storedFile)
          await getStorage().files.create(storedFile)
        }
        if (storedFiles.length === 1 && source.sourceType === 'database') {
          connectionConfig.fileId = storedFiles[0].id
        } else if (storedFiles.length > 0) {
          connectionConfig.fileIds = storedFiles.map((f) => f.id)
          connectionConfig.fileNames = storedFiles.map((f) => f.fileName)
        }
      }
    }

    // Generate unique alias from name (or use explicit override)
    const existingAliases = get().dataSources.map((ds) => ds.alias).filter(Boolean)
    const baseAlias = source.alias ?? generateAlias(localized(source.name, 'en'))
    const alias = ensureUniqueAlias(baseAlias, existingAliases)

    const newSource: DataSource = {
      id,
      alias,
      name: source.name,
      description: source.description,
      sourceType: source.sourceType,
      connectionConfig: connectionConfig as unknown as ConnectionConfig,
      schemaMapping: sanitizeSchemaMapping(source.schemaMapping),
      // Provenance of the copied mapping. The caller passed it and it was dropped:
      // the field was missing from this signature, so a database installed from a
      // published schema recorded nothing about where its schema came from.
      ...(source.schemaSource ? { schemaSource: source.schemaSource } : {}),
      status: 'configuring' as DataSourceStatus,
      ...(source.isVocabularyReference ? { isVocabularyReference: true } : {}),
      // The add dialog has offered these since databases gained badges and a
      // version; they were being passed and dropped on the floor here.
      ...(source.badges?.length ? { badges: source.badges } : {}),
      version: source.version || '0.1.0',
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
      ...stampAuthored(),
      // Cross-instance identity, like every other exportable entity: without it a
      // re-imported database matched nothing and landed as a duplicate.
      ...stampLineage(),
      createdAt: now,
      updatedAt: now,
    }

    await getStorage().dataSources.create(newSource)
    set((s) => ({ dataSources: [...s.dataSources, newSource] }))

    // Now that the source row exists on the server, stream its files up. Doing
    // this before creation would 404 (the import endpoint loads the source).
    if (serverFilesToUpload) {
      for (const file of serverFilesToUpload) {
        const fileName = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        await uploadDataSourceFile(id, file, fileName)
      }
    }

    // Server mode: the source lives on the server — no browser WASM mount.
    // External DBs (Postgres/MySQL) open a live connection; file DBs
    // (DuckDB/SQLite are an `engine`, not a separate sourceType) were uploaded
    // to the blob store above. Either way the schema + counts are read
    // server-side. sourceType is only 'database' | 'fhir'; 'fhir' has no WASM
    // mount path, so gating on 'database' covers every mountable case.
    if (isServerMode() && source.sourceType === 'database') {
      const isExternalEngine =
        connectionConfig.engine === 'postgresql' || connectionConfig.engine === 'mysql'
      let updated: Partial<DataSource>
      try {
        if (isExternalEngine) {
          const result = await testConnectionOnServer(connectionConfig)
          if (!result.ok) throw new Error(result.error ?? 'Connection failed')
        }
        // Only the (free) table count from the schema — no COUNT(*) on connect,
        // so huge databases aren't scanned. Row counts wait for "Load statistics".
        const stats = await engine.computeStats(id, source.schemaMapping, false)
        updated = { status: 'connected', errorMessage: undefined, stats }
      } catch (err) {
        updated = {
          status: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
        }
      }
      await getStorage().dataSources.update(id, updated)
      set((s) => ({
        dataSources: s.dataSources.map((ds) =>
          ds.id === id ? { ...ds, ...updated } : ds,
        ),
      }))
      return id
    }

    // Mount in DuckDB and compute stats
    try {
      if (useFileHandles) {
        await withTimeout(engine.mountDataSourceFromHandles(newSource, storedHandles), MOUNT_TIMEOUT, 'mountDataSourceFromHandles')
      } else {
        await withTimeout(engine.mountDataSource(newSource, storedFiles), MOUNT_TIMEOUT, 'mountDataSource')
      }
      mountedSources.add(id)
      const stats = await withTimeout(engine.computeStats(id, source.schemaMapping), STATS_TIMEOUT, 'computeStats')
      const updated: Partial<DataSource> = { status: 'connected', stats, errorMessage: undefined }
      await getStorage().dataSources.update(id, updated)
      set((s) => ({
        dataSources: s.dataSources.map((ds) =>
          ds.id === id ? { ...ds, ...updated } : ds,
        ),
      }))
    } catch (err) {
      handleDuckDBError(err)
      console.error('Failed to mount data source:', err)
      const errorMessage = err instanceof Error ? err.message : String(err)
      const updated: Partial<DataSource> = { status: 'error', errorMessage }
      await getStorage().dataSources.update(id, updated)
      set((s) => ({
        dataSources: s.dataSources.map((ds) =>
          ds.id === id ? { ...ds, ...updated } : ds,
        ),
      }))
    }

    return id
  },

  updateDataSource: async (id, rawChanges) => {
    // A mapping attached to a source is interpolated into SQL by every
    // warehouse query, and reaches here from an imported or cloned workspace as
    // readily as from the editor — validate its identifiers first.
    const changes = rawChanges.schemaMapping
      ? { ...rawChanges, schemaMapping: sanitizeSchemaMapping(rawChanges.schemaMapping) }
      : rawChanges
    // Await persistence: a follow-up retest reads the stored (encrypted)
    // password server-side, so the write must land before it runs.
    await getStorage().dataSources.update(id, changes)
    set((s) => ({
      dataSources: s.dataSources.map((d) =>
        d.id === id
          ? { ...d, ...changes, updatedAt: new Date().toISOString() }
          : d,
      ),
    }))

  },

  retestDataSource: async (id) => {
    if (!isServerMode()) return
    const ds = get().dataSources.find((d) => d.id === id)
    if (!ds) return
    set((s) => ({
      dataSources: s.dataSources.map((d) =>
        d.id === id ? { ...d, status: 'configuring' as DataSourceStatus } : d,
      ),
    }))
    // A file source (Parquet/CSV/DuckDB/SQLite) has no live connection to test:
    // the server attaches its files on demand, and /retest only knows external
    // engines — it would answer `ok: false` and mark a perfectly good database
    // as broken. Reading its schema back IS the test: tables mean it works.
    // Without this branch a file database had no way out of 'configuring',
    // which gates the Schema tab while the Statistics tab happily queries it.
    const fileEngine = (ds.connectionConfig as { engine?: string } | undefined)?.engine
    if (ds.sourceType !== 'database' || fileEngine === 'duckdb' || fileEngine === 'sqlite') {
      let fileUpdate: Partial<DataSource>
      try {
        const tables = await fetchDataSourceSchema(id)
        fileUpdate = tables.length > 0
          ? { status: 'connected', errorMessage: undefined, stats: { tableCount: tables.length } }
          : { status: 'disconnected', errorMessage: DB_ERROR_NO_DATA_ON_IMPORT }
      } catch (e) {
        fileUpdate = { status: 'error', errorMessage: e instanceof Error ? e.message : String(e) }
      }
      await getStorage().dataSources.update(id, fileUpdate)
      set((s) => ({
        dataSources: s.dataSources.map((d) => (d.id === id ? { ...d, ...fileUpdate } : d)),
      }))
      return
    }
    const result = await retestConnectionOnServer(id)
    let updated: Partial<DataSource>
    if (result.ok) {
      // No COUNT(*) on re-test either — just the free table count from the schema.
      const stats = await engine
        .computeStats(id, ds.schemaMapping, false)
        .catch(() => ({ tableCount: result.tables.length }))
      updated = { status: 'connected', errorMessage: undefined, stats }
    } else {
      updated = { status: 'error', errorMessage: result.error ?? 'Connection failed' }
    }
    await getStorage().dataSources.update(id, updated)
    set((s) => ({
      dataSources: s.dataSources.map((d) => (d.id === id ? { ...d, ...updated } : d)),
    }))
  },

  removeDataSource: async (id) => {
    // Unmount from DuckDB
    if (mountedSources.has(id)) {
      try {
        await engine.unmountDataSource(id)
      } catch {
        // Ignore unmount errors
      }
      mountedSources.delete(id)
    }

    // Unlink from all projects that reference this data source
    const appStore = useAppStore.getState()
    for (const project of appStore._projectsRaw) {
      if (project.linkedDataSourceIds?.includes(id)) {
        appStore.unlinkDataSource(project.uid, id)
      }
    }

    // Delete files/handles, stats cache, and data source from IDB
    await getStorage().files.deleteByDataSource(id)
    await getStorage().fileHandles.deleteByDataSource(id)
    await getStorage().databaseStatsCache.delete(id)
    await getStorage().dataSources.delete(id)

    set((s) => {
      // Clean up active selection if this was the active source
      const next = { ...s.activeDataSourceIds }
      for (const [projectUid, dsId] of Object.entries(next)) {
        if (dsId === id) delete next[projectUid]
      }
      saveActiveDataSourceIds(next)
      return {
        dataSources: s.dataSources.filter((d) => d.id !== id),
        activeDataSourceIds: next,
      }
    })

  },

  createEmptyDatabase: async (source) => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    // Front-only keeps the tables in the browser's own DuckDB (in-memory).
    // In server mode they must exist on disk, so the server materialises a
    // managed file from the DDL below and flags the config `managed`.
    const connectionConfig: DatabaseConnectionConfig = isServerMode()
      ? { engine: 'duckdb', managed: true }
      : { engine: 'duckdb', inMemory: true }

    // Generate unique alias
    const existingAliases = get().dataSources.map((ds) => ds.alias).filter(Boolean)
    const baseAlias = source.alias ?? generateAlias(localized(source.name, 'en'))
    const alias = ensureUniqueAlias(baseAlias, existingAliases)

    const newSource: DataSource = {
      id,
      alias,
      name: source.name,
      description: source.description,
      sourceType: 'database',
      connectionConfig: connectionConfig as unknown as ConnectionConfig,
      schemaMapping: sanitizeSchemaMapping(source.schemaMapping),
      status: 'configuring' as DataSourceStatus,
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
      ...stampAuthored(),
      // Cross-instance identity, like every other exportable entity: without it a
      // re-imported database matched nothing and landed as a duplicate.
      ...stampLineage(),
      createdAt: now,
      updatedAt: now,
    }

    await getStorage().dataSources.create(newSource)
    set((s) => ({ dataSources: [...s.dataSources, newSource] }))

    try {
      if (isServerMode()) {
        await createFromDdlOnServer(id, source.ddl)
      } else {
        await withTimeout(engine.mountEmptyFromDDL(id, source.ddl, alias), MOUNT_TIMEOUT, 'mountEmptyFromDDL')
        mountedSources.add(id)
      }
      const stats = await withTimeout(engine.computeStats(id, source.schemaMapping), STATS_TIMEOUT, 'computeStats')
      const updated: Partial<DataSource> = { status: 'connected', stats, errorMessage: undefined }
      await getStorage().dataSources.update(id, updated)
      set((s) => ({
        dataSources: s.dataSources.map((ds) =>
          ds.id === id ? { ...ds, ...updated } : ds,
        ),
      }))
    } catch (err) {
      handleDuckDBError(err)
      console.error('Failed to create empty database:', err)
      const errorMessage = err instanceof Error ? err.message : String(err)
      const updated: Partial<DataSource> = { status: 'error', errorMessage }
      await getStorage().dataSources.update(id, updated)
      set((s) => ({
        dataSources: s.dataSources.map((ds) =>
          ds.id === id ? { ...ds, ...updated } : ds,
        ),
      }))
    }

    return id
  },

  testConnection: async (id) => {
    // Server mode: nothing mounts in the browser. The server owns the connection
    // and runs queries; re-validating goes through retestDataSource, not a WASM
    // mount. Callers that just want to run SQL don't need to do anything here.
    if (isServerMode()) return
    const ds = get().dataSources.find((d) => d.id === id)
    if (!ds || busySources.has(id)) return
    const config = ds.connectionConfig as DatabaseConnectionConfig

    busySources.add(id)
    set((s) => ({
      dataSources: s.dataSources.map((d) =>
        d.id === id ? { ...d, status: 'configuring' as DataSourceStatus } : d,
      ),
    }))

    try {
      if (!mountedSources.has(id)) {
        if (config.inMemory && ds.schemaMapping?.ddl) {
          // In-memory database: remount from DDL
          await withTimeout(engine.mountEmptyFromDDL(id, ds.schemaMapping.ddl, ds.alias), MOUNT_TIMEOUT, 'mountEmptyFromDDL')
        } else if (config.useFileHandles) {
          const handles = await getStorage().fileHandles.getByDataSource(id)
          const granted = await engine.requestHandlePermissions(handles)
          if (!granted) throw new Error('File access permission denied')
          await withTimeout(engine.mountDataSourceFromHandles(ds, handles), MOUNT_TIMEOUT, 'mountDataSourceFromHandles')
        } else {
          const files = await getStorage().files.getByDataSource(id)
          await withTimeout(engine.mountDataSource(ds, files), MOUNT_TIMEOUT, 'mountDataSource')
        }
        mountedSources.add(id)
      }

      const stats = await withTimeout(engine.computeStats(id, ds.schemaMapping), STATS_TIMEOUT, 'computeStats')
      const updated: Partial<DataSource> = { status: 'connected', stats, errorMessage: undefined }
      await getStorage().dataSources.update(id, updated)
      set((s) => ({
        dataSources: s.dataSources.map((d) =>
          d.id === id ? { ...d, ...updated } : d,
        ),
      }))
    } catch (err) {
      handleDuckDBError(err)
      console.error('[testConnection] failed:', err)
      const errorMessage = err instanceof Error ? err.message : String(err)
      const updated: Partial<DataSource> = { status: 'error', errorMessage }
      await getStorage().dataSources.update(id, updated)
      set((s) => ({
        dataSources: s.dataSources.map((d) =>
          d.id === id ? { ...d, ...updated } : d,
        ),
      }))
    } finally {
      busySources.delete(id)
    }
  },

  disconnectDataSource: async (id) => {
    const ds = get().dataSources.find((d) => d.id === id)
    if (!ds || ds.status === 'disconnected') return

    try {
      await engine.unmountDataSource(id)
    } catch {
      // Ignore — may already be unmounted
    }
    mountedSources.delete(id)

    const updated: Partial<DataSource> = { status: 'disconnected' }
    await getStorage().dataSources.update(id, updated)
    set((s) => ({
      dataSources: s.dataSources.map((d) =>
        d.id === id ? { ...d, ...updated } : d,
      ),
    }))
  },

  mountProjectSources: async (projectUid: string) => {
    // Server mode: sources are queried server-side, nothing is mounted in the
    // browser (mounting would download the file bytes — the very thing we avoid).
    if (isServerMode()) return
    const linkedIds = useAppStore.getState().getProjectLinkedDataSourceIds(projectUid)
    const sources = get().dataSources.filter(
      (ds) => linkedIds.includes(ds.id) && !mountedSources.has(ds.id) && !busySources.has(ds.id),
    )

    for (const ds of sources) {
      if (busySources.has(ds.id)) continue
      busySources.add(ds.id)
      const config = ds.connectionConfig as DatabaseConnectionConfig
      try {
        if (config.useFileHandles) {
          const handles = await getStorage().fileHandles.getByDataSource(ds.id)
          if (handles.length === 0) { busySources.delete(ds.id); continue }
          const granted = await engine.requestHandlePermissions(handles)
          if (!granted) {
            const updated: Partial<DataSource> = { status: 'disconnected' }
            await getStorage().dataSources.update(ds.id, updated)
            set((s) => ({
              dataSources: s.dataSources.map((d) =>
                d.id === ds.id ? { ...d, ...updated } : d,
              ),
            }))
            busySources.delete(ds.id)
            continue
          }
          await withTimeout(engine.mountDataSourceFromHandles(ds, handles), MOUNT_TIMEOUT, 'mountDataSourceFromHandles')
        } else {
          const files = await getStorage().files.getByDataSource(ds.id)
          if (files.length === 0) { busySources.delete(ds.id); continue }
          await withTimeout(engine.mountDataSource(ds, files), MOUNT_TIMEOUT, 'mountDataSource')
        }
        mountedSources.add(ds.id)
        const stats = await withTimeout(engine.computeStats(ds.id, ds.schemaMapping), STATS_TIMEOUT, 'computeStats')
        const updated: Partial<DataSource> = { status: 'connected', stats, errorMessage: undefined }
        await getStorage().dataSources.update(ds.id, updated)
        set((s) => ({
          dataSources: s.dataSources.map((d) =>
            d.id === ds.id ? { ...d, ...updated } : d,
          ),
        }))
      } catch (err) {
        handleDuckDBError(err)
        console.error(`[mountProjectSources] failed ${ds.id}:`, err)
        const errorMessage = err instanceof Error ? err.message : String(err)
        const errUpdated: Partial<DataSource> = { status: 'error', errorMessage }
        await getStorage().dataSources.update(ds.id, errUpdated)
        set((s) => ({
          dataSources: s.dataSources.map((d) =>
            d.id === ds.id ? { ...d, ...errUpdated } : d,
          ),
        }))
      } finally {
        busySources.delete(ds.id)
      }
    }
  },

  reconnectDataSource: async (id) => {
    // Server mode: no browser-side FS Access handles to re-permission.
    if (isServerMode()) return
    const ds = get().dataSources.find((d) => d.id === id)
    if (!ds || busySources.has(id)) return
    const config = ds.connectionConfig as DatabaseConnectionConfig
    if (!config.useFileHandles) return

    busySources.add(id)
    set((s) => ({
      dataSources: s.dataSources.map((d) =>
        d.id === id ? { ...d, status: 'configuring' as DataSourceStatus } : d,
      ),
    }))

    try {
      const handles = await getStorage().fileHandles.getByDataSource(id)
      const granted = await engine.requestHandlePermissions(handles)
      if (!granted) {
        const updated: Partial<DataSource> = { status: 'disconnected' }
        await getStorage().dataSources.update(id, updated)
        set((s) => ({
          dataSources: s.dataSources.map((d) =>
            d.id === id ? { ...d, ...updated } : d,
          ),
        }))
        return
      }
      await withTimeout(engine.mountDataSourceFromHandles(ds, handles), MOUNT_TIMEOUT, 'mountDataSourceFromHandles')
      mountedSources.add(id)
      const stats = await withTimeout(engine.computeStats(id, ds.schemaMapping), STATS_TIMEOUT, 'computeStats')
      const updated: Partial<DataSource> = { status: 'connected', stats, errorMessage: undefined }
      await getStorage().dataSources.update(id, updated)
      set((s) => ({
        dataSources: s.dataSources.map((d) =>
          d.id === id ? { ...d, ...updated } : d,
        ),
      }))
    } catch (err) {
      handleDuckDBError(err)
      console.error('Reconnect failed:', err)
      const errorMessage = err instanceof Error ? err.message : String(err)
      const updated: Partial<DataSource> = { status: 'error', errorMessage }
      await getStorage().dataSources.update(id, updated)
      set((s) => ({
        dataSources: s.dataSources.map((d) =>
          d.id === id ? { ...d, ...updated } : d,
        ),
      }))
    } finally {
      busySources.delete(id)
    }
  },

  ensureMounted: async (id) => {
    // Server mode: nothing is mounted in the browser — the server holds the data
    // and runs queries. Callers (e.g. stats) proceed straight to server queries.
    if (isServerMode()) return
    if (mountedSources.has(id)) return
    // Deduplicate concurrent mount calls for the same source
    const existing = mountingPromises.get(id)
    if (existing) return existing
    const promise = (async () => {
      const ds = get().dataSources.find((d) => d.id === id)
      if (!ds) throw new Error(`Data source ${id} not found`)
      const config = ds.connectionConfig as DatabaseConnectionConfig
      if (config.inMemory && ds.schemaMapping?.ddl) {
        await withTimeout(engine.mountEmptyFromDDL(id, ds.schemaMapping.ddl), MOUNT_TIMEOUT, 'mountEmptyFromDDL')
      } else if (config.useFileHandles) {
        const handles = await getStorage().fileHandles.getByDataSource(id)
        const granted = await engine.requestHandlePermissions(handles)
        if (!granted) throw new Error('File access permission denied')
        await withTimeout(engine.mountDataSourceFromHandles(ds, handles), MOUNT_TIMEOUT, 'mountDataSourceFromHandles')
      } else {
        const files = await getStorage().files.getByDataSource(id)
        await withTimeout(engine.mountDataSource(ds, files), MOUNT_TIMEOUT, 'mountDataSource')
      }
      mountedSources.add(id)
    })()
    mountingPromises.set(id, promise)
    try {
      await promise
    } finally {
      mountingPromises.delete(id)
    }
  },
}))
