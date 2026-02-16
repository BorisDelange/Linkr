import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import * as engine from '@/lib/duckdb/engine'
import { useDataSourceStore } from './data-source-store'
import type {
  IdeConnection,
  DatabaseConnectionConfig,
  DatabaseEngine,
  DataSourceStatus,
  StoredFile,
  StoredFileHandle,
} from '@/types'

export interface ConnectionEntry {
  id: string
  name: string
  source: 'warehouse' | 'custom'
  engine: string
  status: DataSourceStatus
  errorMessage?: string
}

interface ConnectionState {
  customConnections: IdeConnection[]
  activeConnectionId: string | null

  loadProjectConnections: (projectUid: string) => Promise<void>

  /** Get all connections (warehouse + custom) for the active project. */
  getProjectConnections: (projectUid: string) => ConnectionEntry[]

  addCustomConnection: (source: {
    projectUid: string
    name: string
    engine: DatabaseEngine
    files?: File[]
    fileHandles?: { fileName: string; handle: FileSystemFileHandle; fileSize: number }[]
    remoteConfig?: {
      host: string
      port?: number
      database?: string
      schema?: string
      username?: string
      password?: string
    }
  }) => Promise<string>

  removeCustomConnection: (id: string) => Promise<void>

  setActiveConnection: (id: string | null) => void
}

/** Track mounted custom connections. */
const mountedCustom = new Set<string>()

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  customConnections: [],
  activeConnectionId: null,

  loadProjectConnections: async (projectUid: string) => {
    const conns = await getStorage().connections.getByProject(projectUid)
    set({ customConnections: conns })

    // Mount custom connections that aren't mounted yet
    for (const conn of conns) {
      if (mountedCustom.has(conn.id)) continue
      try {
        const config = conn.connectionConfig
        if (config.useFileHandles) {
          const handles = await getStorage().fileHandles.getByDataSource(conn.id)
          if (handles.length === 0) continue
          const granted = await engine.requestHandlePermissions(handles)
          if (!granted) {
            await updateConnStatus(conn.id, 'disconnected', set, get)
            continue
          }
          // Build a minimal DataSource-like object for mounting
          const dsMock = { id: conn.id, connectionConfig: config, schemaMapping: undefined } as Parameters<typeof engine.mountDataSourceFromHandles>[0]
          await engine.mountDataSourceFromHandles(dsMock, handles)
        } else {
          const files = await getStorage().files.getByDataSource(conn.id)
          if (files.length === 0) continue
          const dsMock = { id: conn.id, connectionConfig: config, schemaMapping: undefined } as Parameters<typeof engine.mountDataSource>[0]
          await engine.mountDataSource(dsMock, files)
        }
        mountedCustom.add(conn.id)
        await updateConnStatus(conn.id, 'connected', set, get)
      } catch (err) {
        console.error(`Failed to mount custom connection ${conn.id}:`, err)
        const msg = err instanceof Error ? err.message : String(err)
        await updateConnStatus(conn.id, 'error', set, get, msg)
      }
    }
  },

  getProjectConnections: (projectUid: string) => {
    // Warehouse connections from data source store
    const dataSources = useDataSourceStore.getState().getProjectSources(projectUid)
    const warehouseEntries: ConnectionEntry[] = dataSources
      .filter((ds) => ds.sourceType === 'database')
      .map((ds) => ({
        id: ds.id,
        name: ds.name,
        source: 'warehouse' as const,
        engine: (ds.connectionConfig as DatabaseConnectionConfig).engine,
        status: ds.status,
        errorMessage: ds.errorMessage,
      }))

    // Custom connections
    const customEntries: ConnectionEntry[] = get()
      .customConnections.filter((c) => c.projectUid === projectUid)
      .map((c) => ({
        id: c.id,
        name: c.name,
        source: 'custom' as const,
        engine: c.connectionConfig.engine,
        status: c.status,
        errorMessage: c.errorMessage,
      }))

    return [...warehouseEntries, ...customEntries]
  },

  addCustomConnection: async (source) => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const isLocal = source.engine === 'duckdb' || source.engine === 'sqlite'

    const useFileHandles = !!(source.fileHandles && source.fileHandles.length > 0)
    const connectionConfig: DatabaseConnectionConfig = { engine: source.engine }

    const storedHandles: StoredFileHandle[] = []
    const storedFiles: StoredFile[] = []

    if (isLocal) {
      // Local engine: file-based
      if (useFileHandles && source.fileHandles) {
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
      } else if (source.files && source.files.length > 0) {
        for (const file of source.files) {
          const data = await file.arrayBuffer()
          const storedFile: StoredFile = {
            id: crypto.randomUUID(),
            dataSourceId: id,
            fileName: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
            fileSize: file.size,
            data,
            createdAt: now,
          }
          storedFiles.push(storedFile)
          await getStorage().files.create(storedFile)
        }
        if (storedFiles.length === 1) {
          connectionConfig.fileId = storedFiles[0].id
        } else {
          connectionConfig.fileIds = storedFiles.map((f) => f.id)
          connectionConfig.fileNames = storedFiles.map((f) => f.fileName)
        }
      }
    } else if (source.remoteConfig) {
      // Remote engine: host/port/credentials
      connectionConfig.host = source.remoteConfig.host
      connectionConfig.port = source.remoteConfig.port
      connectionConfig.database = source.remoteConfig.database
      connectionConfig.schema = source.remoteConfig.schema
      connectionConfig.username = source.remoteConfig.username
      connectionConfig.password = source.remoteConfig.password
    }

    const conn: IdeConnection = {
      id,
      projectUid: source.projectUid,
      name: source.name,
      source: 'custom',
      connectionConfig,
      status: isLocal ? 'configuring' : 'disconnected',
      createdAt: now,
    }

    await getStorage().connections.create(conn)
    set((s) => ({ customConnections: [...s.customConnections, conn] }))

    if (isLocal) {
      // Mount in DuckDB
      try {
        const dsMock = { id, connectionConfig, schemaMapping: undefined } as Parameters<typeof engine.mountDataSource>[0]
        if (useFileHandles) {
          await engine.mountDataSourceFromHandles(dsMock, storedHandles)
        } else {
          await engine.mountDataSource(dsMock, storedFiles)
        }
        mountedCustom.add(id)
        await updateConnStatus(id, 'connected', set, get)
      } catch (err) {
        console.error('Failed to mount custom connection:', err)
        const msg = err instanceof Error ? err.message : String(err)
        await updateConnStatus(id, 'error', set, get, msg)
      }
    }
    // Remote connections remain 'disconnected' until a backend is available

    return id
  },

  removeCustomConnection: async (id) => {
    if (mountedCustom.has(id)) {
      try {
        await engine.unmountDataSource(id)
      } catch {
        // Ignore
      }
      mountedCustom.delete(id)
    }

    await getStorage().files.deleteByDataSource(id)
    await getStorage().fileHandles.deleteByDataSource(id)
    await getStorage().connections.delete(id)

    set((s) => ({
      customConnections: s.customConnections.filter((c) => c.id !== id),
      activeConnectionId: s.activeConnectionId === id ? null : s.activeConnectionId,
    }))
  },

  setActiveConnection: (id) => set({ activeConnectionId: id }),
}))

// Helper to update connection status in both store and IDB
type SetFn = Parameters<Parameters<typeof create<ConnectionState>>[0]>[0]
type GetFn = Parameters<Parameters<typeof create<ConnectionState>>[0]>[1]

async function updateConnStatus(
  id: string,
  status: DataSourceStatus,
  set: SetFn,
  get: GetFn,
  errorMessage?: string,
) {
  const changes: Partial<IdeConnection> = { status, errorMessage }
  await getStorage().connections.update(id, changes)
  const conns = get().customConnections
  set({
    customConnections: conns.map((c) =>
      c.id === id ? { ...c, ...changes } : c,
    ),
  })
}
