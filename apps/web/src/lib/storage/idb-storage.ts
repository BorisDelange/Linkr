import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Project, DataSource, StoredFile, StoredFileHandle, Cohort, DatabaseStatsCache, Pipeline, ReadmeAttachment, CustomSchemaPreset, IdeConnection, IdeFile, DatasetFile, DatasetData, DatasetAnalysis, UserPlugin, Dashboard, DashboardTab, DashboardWidget, Workspace, Organization } from '@/types'
import type { Storage, OrganizationStorage, WorkspaceStorage, ProjectStorage, DataSourceStorage, FileStorage, FileHandleStorage, CohortStorage, DatabaseStatsCacheStorage, SchemaPresetStorage, PipelineStorage, ReadmeAttachmentStorage, ConnectionStorage, IdeFileStorage, DatasetFileStorage, DatasetDataStorage, DatasetAnalysisStorage, UserPluginStorage, DashboardStorage, DashboardTabStorage, DashboardWidgetStorage } from './index'
import { getSchemaPreset } from '@/lib/schema-presets'

interface LinkrDB extends DBSchema {
  organizations: {
    key: string
    value: Organization
  }
  workspaces: {
    key: string
    value: Workspace
    indexes: {
      'by-updated': string
    }
  }
  projects: {
    key: string
    value: Project
    indexes: {
      'by-updated': string
    }
  }
  data_sources: {
    key: string
    value: DataSource
    indexes: {
      'by-project': string
    }
  }
  files: {
    key: string
    value: StoredFile
    indexes: {
      'by-data-source': string
    }
  }
  cohorts: {
    key: string
    value: Cohort
    indexes: {
      'by-project': string
    }
  }
  database_stats_cache: {
    key: string
    value: DatabaseStatsCache
  }
  pipelines: {
    key: string
    value: Pipeline
    indexes: {
      'by-project': string
    }
  }
  readme_attachments: {
    key: string
    value: ReadmeAttachment
    indexes: {
      'by-project': string
    }
  }
  schema_presets: {
    key: string
    value: CustomSchemaPreset
  }
  file_handles: {
    key: string
    value: StoredFileHandle
    indexes: {
      'by-data-source': string
    }
  }
  ide_connections: {
    key: string
    value: IdeConnection
    indexes: {
      'by-project': string
    }
  }
  ide_files: {
    key: string
    value: IdeFile
    indexes: {
      'by-project': string
    }
  }
  dataset_files: {
    key: string
    value: DatasetFile
    indexes: {
      'by-project': string
    }
  }
  dataset_data: {
    key: string
    value: DatasetData
  }
  dataset_analyses: {
    key: string
    value: DatasetAnalysis
    indexes: {
      'by-dataset': string
    }
  }
  user_plugins: {
    key: string
    value: UserPlugin
  }
  dashboards: {
    key: string
    value: Dashboard
    indexes: {
      'by-project': string
    }
  }
  dashboard_tabs: {
    key: string
    value: DashboardTab
    indexes: {
      'by-dashboard': string
    }
  }
  dashboard_widgets: {
    key: string
    value: DashboardWidget
    indexes: {
      'by-tab': string
    }
  }
}

const DB_NAME = 'linkr'
const DB_VERSION = 17

let _dbPromise: Promise<IDBPDatabase<LinkrDB>> | null = null

function getDB(): Promise<IDBPDatabase<LinkrDB>> {
  if (_dbPromise) return _dbPromise
  _dbPromise = openDB<LinkrDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      // Version 1: projects
      if (oldVersion < 1) {
        const projectStore = db.createObjectStore('projects', { keyPath: 'uid' })
        projectStore.createIndex('by-updated', 'updatedAt')
      }
      // Version 2: data_sources + files
      if (oldVersion < 2) {
        const dsStore = db.createObjectStore('data_sources', { keyPath: 'id' })
        dsStore.createIndex('by-project', 'projectUid')
        const fileStore = db.createObjectStore('files', { keyPath: 'id' })
        fileStore.createIndex('by-data-source', 'dataSourceId')
      }
      // Version 3: cohorts
      if (oldVersion < 3) {
        const cohortStore = db.createObjectStore('cohorts', { keyPath: 'id' })
        cohortStore.createIndex('by-project', 'projectUid')
      }
      // Version 4: OMOP stats cache (legacy name, migrated in v6)
      if (oldVersion < 4) {
        db.createObjectStore('omop_stats_cache' as never, { keyPath: 'dataSourceId' })
      }
      // Version 5: pipelines
      if (oldVersion < 5) {
        const pipelineStore = db.createObjectStore('pipelines', { keyPath: 'id' })
        pipelineStore.createIndex('by-project', 'projectUid')
      }
      // Version 6: rename omop_stats_cache → database_stats_cache, migrate data sources
      if (oldVersion < 6) {
        // Create new stats cache store
        db.createObjectStore('database_stats_cache', { keyPath: 'dataSourceId' })

        // Migrate data from old omop_stats_cache to new store
        if (oldVersion >= 4) {
          // Use raw IDB transaction to access the legacy store
          const rawTx = (transaction as unknown as { store: never }).store
            ? transaction
            : transaction
          const oldStore = rawTx.objectStore('omop_stats_cache' as never)
          const newStore = rawTx.objectStore('database_stats_cache' as never)
          // idb wraps getAll() as Promise — use .then() within the upgrade transaction
          ;(oldStore.getAll() as Promise<DatabaseStatsCache[]>).then((entries) => {
            for (const entry of entries) {
              ;(newStore as { put: (v: DatabaseStatsCache) => void }).put(entry)
            }
          })
          db.deleteObjectStore('omop_stats_cache' as never)
        }

        // Migrate data sources: add schemaMapping, normalize sourceType
        if (oldVersion >= 2) {
          const dsStore = transaction.objectStore('data_sources')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(dsStore.getAll() as Promise<any[]>).then((sources) => {
            for (const ds of sources) {
              let changed = false
              if (ds.sourceType === 'omop') {
                ds.sourceType = 'database'
                ds.schemaMapping = getSchemaPreset('omop-5.4')
                changed = true
              } else if (ds.sourceType === 'csv' || ds.sourceType === 'parquet') {
                ds.sourceType = 'database'
                ds.schemaMapping = getSchemaPreset('none')
                changed = true
              } else if (ds.sourceType === 'database' && !ds.schemaMapping) {
                ds.schemaMapping = getSchemaPreset('none')
                changed = true
              }
              if (changed) {
                dsStore.put(ds)
              }
            }
          })
        }
      }
      // Version 7: readme_attachments
      if (oldVersion < 7) {
        const attachStore = db.createObjectStore('readme_attachments', { keyPath: 'id' })
        attachStore.createIndex('by-project', 'projectUid')
      }
      // Version 8: schema_presets
      if (oldVersion < 8) {
        db.createObjectStore('schema_presets', { keyPath: 'presetId' })
      }
      // Version 9: file_handles (File System Access API zero-copy references)
      if (oldVersion < 9) {
        const fhStore = db.createObjectStore('file_handles', { keyPath: 'id' })
        fhStore.createIndex('by-data-source', 'dataSourceId')
      }
      // Version 10: ide_connections (IDE custom connections)
      if (oldVersion < 10) {
        const connStore = db.createObjectStore('ide_connections', { keyPath: 'id' })
        connStore.createIndex('by-project', 'projectUid')
      }
      // Version 11: ide_files (IDE code editor files)
      if (oldVersion < 11) {
        const ideFileStore = db.createObjectStore('ide_files', { keyPath: 'id' })
        ideFileStore.createIndex('by-project', 'projectUid')
      }
      // Version 12: Move databases from project-owned to app-level
      // Transfer projectUid from data_sources into project.linkedDataSourceIds
      if (oldVersion < 12 && oldVersion >= 2) {
        const dsStore = transaction.objectStore('data_sources')
        const projStore = transaction.objectStore('projects')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(dsStore.getAll() as Promise<any[]>).then((sources) => {
          const byProject = new Map<string, string[]>()
          for (const ds of sources) {
            if (ds.projectUid) {
              const list = byProject.get(ds.projectUid) ?? []
              list.push(ds.id)
              byProject.set(ds.projectUid, list)
              // Remove projectUid from the data source record
              delete ds.projectUid
              dsStore.put(ds)
            }
          }
          // Update each project with linkedDataSourceIds
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(projStore.getAll() as Promise<any[]>).then((projects) => {
            for (const project of projects) {
              const linkedIds = byProject.get(project.uid) ?? []
              if (linkedIds.length > 0) {
                project.linkedDataSourceIds = linkedIds
                projStore.put(project)
              }
            }
          })
        })
      }
      // Version 13: Dataset files, data, and analyses
      if (oldVersion < 13) {
        const dsFileStore = db.createObjectStore('dataset_files', { keyPath: 'id' })
        dsFileStore.createIndex('by-project', 'projectUid')
        db.createObjectStore('dataset_data', { keyPath: 'datasetFileId' })
        const dsAnalysisStore = db.createObjectStore('dataset_analyses', { keyPath: 'id' })
        dsAnalysisStore.createIndex('by-dataset', 'datasetFileId')
      }
      // Version 14: User-created plugins
      if (oldVersion < 14) {
        db.createObjectStore('user_plugins', { keyPath: 'id' })
      }
      // Version 15: Dashboard system (dashboards, tabs, widgets)
      if (oldVersion < 15) {
        const dashStore = db.createObjectStore('dashboards', { keyPath: 'id' })
        dashStore.createIndex('by-project', 'projectUid')
        const tabStore = db.createObjectStore('dashboard_tabs', { keyPath: 'id' })
        tabStore.createIndex('by-dashboard', 'dashboardId')
        const widgetStore = db.createObjectStore('dashboard_widgets', { keyPath: 'id' })
        widgetStore.createIndex('by-tab', 'tabId')
      }
      // Version 16: Workspaces
      if (oldVersion < 16) {
        const wsStore = db.createObjectStore('workspaces', { keyPath: 'id' })
        wsStore.createIndex('by-updated', 'updatedAt')
      }
      // Version 17: Organizations as first-class entity
      // Extract embedded organization from each workspace, deduplicate by name,
      // create Organization records, and link workspaces via organizationId.
      if (oldVersion < 17) {
        db.createObjectStore('organizations', { keyPath: 'id' })
        // Migrate existing workspace org data
        if (oldVersion >= 16) {
          const wsStore = transaction.objectStore('workspaces')
          const orgStore = transaction.objectStore('organizations')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(wsStore.getAll() as Promise<any[]>).then((workspaces) => {
            const orgByName = new Map<string, string>() // name → org id
            const now = new Date().toISOString()
            for (const ws of workspaces) {
              if (ws.organization?.name && !ws.organizationId) {
                const name = ws.organization.name
                if (!orgByName.has(name)) {
                  const orgId = crypto.randomUUID()
                  orgByName.set(name, orgId)
                  orgStore.put({
                    id: orgId,
                    ...ws.organization,
                    createdAt: now,
                    updatedAt: now,
                  })
                }
                ws.organizationId = orgByName.get(name)
                wsStore.put(ws)
              }
            }
          })
        }
      }
    },
  })
  _dbPromise.catch(() => { _dbPromise = null })
  return _dbPromise
}

class IDBOrganizationStorage implements OrganizationStorage {
  async getAll(): Promise<Organization[]> {
    const db = await getDB()
    return db.getAll('organizations')
  }

  async getById(id: string): Promise<Organization | undefined> {
    const db = await getDB()
    return db.get('organizations', id)
  }

  async create(org: Organization): Promise<void> {
    const db = await getDB()
    await db.add('organizations', org)
  }

  async update(id: string, changes: Partial<Organization>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('organizations', id)
    if (!existing) return
    await db.put('organizations', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('organizations', id)
  }
}

class IDBWorkspaceStorage implements WorkspaceStorage {
  async getAll(): Promise<Workspace[]> {
    const db = await getDB()
    return db.getAll('workspaces')
  }

  async getById(id: string): Promise<Workspace | undefined> {
    const db = await getDB()
    return db.get('workspaces', id)
  }

  async create(workspace: Workspace): Promise<void> {
    const db = await getDB()
    await db.add('workspaces', workspace)
  }

  async update(id: string, changes: Partial<Workspace>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('workspaces', id)
    if (!existing) return
    await db.put('workspaces', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('workspaces', id)
  }
}

class IDBProjectStorage implements ProjectStorage {
  async getAll(): Promise<Project[]> {
    const db = await getDB()
    return db.getAll('projects')
  }

  async getById(uid: string): Promise<Project | undefined> {
    const db = await getDB()
    return db.get('projects', uid)
  }

  async create(project: Project): Promise<void> {
    const db = await getDB()
    await db.add('projects', project)
  }

  async update(uid: string, changes: Partial<Project>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('projects', uid)
    if (!existing) return
    await db.put('projects', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(uid: string): Promise<void> {
    const db = await getDB()
    await db.delete('projects', uid)
  }
}

class IDBDataSourceStorage implements DataSourceStorage {
  async getAll(): Promise<DataSource[]> {
    const db = await getDB()
    return db.getAll('data_sources')
  }

  async getByProject(projectUid: string): Promise<DataSource[]> {
    const db = await getDB()
    return db.getAllFromIndex('data_sources', 'by-project', projectUid)
  }

  async getById(id: string): Promise<DataSource | undefined> {
    const db = await getDB()
    return db.get('data_sources', id)
  }

  async create(dataSource: DataSource): Promise<void> {
    const db = await getDB()
    await db.add('data_sources', dataSource)
  }

  async update(id: string, changes: Partial<DataSource>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('data_sources', id)
    if (!existing) return
    await db.put('data_sources', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('data_sources', id)
  }
}

class IDBFileStorage implements FileStorage {
  async getByDataSource(dataSourceId: string): Promise<StoredFile[]> {
    const db = await getDB()
    return db.getAllFromIndex('files', 'by-data-source', dataSourceId)
  }

  async getById(id: string): Promise<StoredFile | undefined> {
    const db = await getDB()
    return db.get('files', id)
  }

  async create(file: StoredFile): Promise<void> {
    const db = await getDB()
    await db.add('files', file)
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('files', id)
  }

  async deleteByDataSource(dataSourceId: string): Promise<void> {
    const db = await getDB()
    const files = await db.getAllFromIndex('files', 'by-data-source', dataSourceId)
    const tx = db.transaction('files', 'readwrite')
    for (const file of files) {
      tx.store.delete(file.id)
    }
    await tx.done
  }
}

class IDBFileHandleStorage implements FileHandleStorage {
  async getByDataSource(dataSourceId: string): Promise<StoredFileHandle[]> {
    const db = await getDB()
    return db.getAllFromIndex('file_handles', 'by-data-source', dataSourceId)
  }

  async create(handle: StoredFileHandle): Promise<void> {
    const db = await getDB()
    await db.add('file_handles', handle)
  }

  async deleteByDataSource(dataSourceId: string): Promise<void> {
    const db = await getDB()
    const handles = await db.getAllFromIndex('file_handles', 'by-data-source', dataSourceId)
    const tx = db.transaction('file_handles', 'readwrite')
    for (const h of handles) {
      tx.store.delete(h.id)
    }
    await tx.done
  }
}

class IDBCohortStorage implements CohortStorage {
  async getAll(): Promise<Cohort[]> {
    const db = await getDB()
    return db.getAll('cohorts')
  }

  async getByProject(projectUid: string): Promise<Cohort[]> {
    const db = await getDB()
    return db.getAllFromIndex('cohorts', 'by-project', projectUid)
  }

  async getById(id: string): Promise<Cohort | undefined> {
    const db = await getDB()
    return db.get('cohorts', id)
  }

  async create(cohort: Cohort): Promise<void> {
    const db = await getDB()
    await db.add('cohorts', cohort)
  }

  async update(id: string, changes: Partial<Cohort>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('cohorts', id)
    if (!existing) return
    await db.put('cohorts', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('cohorts', id)
  }
}

class IDBDatabaseStatsCacheStorage implements DatabaseStatsCacheStorage {
  async get(dataSourceId: string): Promise<DatabaseStatsCache | undefined> {
    const db = await getDB()
    return db.get('database_stats_cache', dataSourceId)
  }

  async save(cache: DatabaseStatsCache): Promise<void> {
    const db = await getDB()
    await db.put('database_stats_cache', cache)
  }

  async delete(dataSourceId: string): Promise<void> {
    const db = await getDB()
    await db.delete('database_stats_cache', dataSourceId)
  }
}

class IDBPipelineStorage implements PipelineStorage {
  async getAll(): Promise<Pipeline[]> {
    const db = await getDB()
    return db.getAll('pipelines')
  }

  async getByProject(projectUid: string): Promise<Pipeline[]> {
    const db = await getDB()
    return db.getAllFromIndex('pipelines', 'by-project', projectUid)
  }

  async getById(id: string): Promise<Pipeline | undefined> {
    const db = await getDB()
    return db.get('pipelines', id)
  }

  async create(pipeline: Pipeline): Promise<void> {
    const db = await getDB()
    await db.add('pipelines', pipeline)
  }

  async update(id: string, changes: Partial<Pipeline>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('pipelines', id)
    if (!existing) return
    await db.put('pipelines', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('pipelines', id)
  }
}

class IDBSchemaPresetStorage implements SchemaPresetStorage {
  async getAll(): Promise<CustomSchemaPreset[]> {
    const db = await getDB()
    return db.getAll('schema_presets')
  }

  async getById(presetId: string): Promise<CustomSchemaPreset | undefined> {
    const db = await getDB()
    return db.get('schema_presets', presetId)
  }

  async save(preset: CustomSchemaPreset): Promise<void> {
    const db = await getDB()
    await db.put('schema_presets', preset)
  }

  async delete(presetId: string): Promise<void> {
    const db = await getDB()
    await db.delete('schema_presets', presetId)
  }
}

class IDBReadmeAttachmentStorage implements ReadmeAttachmentStorage {
  async getByProject(projectUid: string): Promise<ReadmeAttachment[]> {
    const db = await getDB()
    return db.getAllFromIndex('readme_attachments', 'by-project', projectUid)
  }

  async getById(id: string): Promise<ReadmeAttachment | undefined> {
    const db = await getDB()
    return db.get('readme_attachments', id)
  }

  async create(attachment: ReadmeAttachment): Promise<void> {
    const db = await getDB()
    await db.add('readme_attachments', attachment)
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('readme_attachments', id)
  }

  async deleteByProject(projectUid: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('readme_attachments', 'by-project', projectUid)
    const tx = db.transaction('readme_attachments', 'readwrite')
    for (const item of items) {
      tx.store.delete(item.id)
    }
    await tx.done
  }
}

class IDBConnectionStorage implements ConnectionStorage {
  async getByProject(projectUid: string): Promise<IdeConnection[]> {
    const db = await getDB()
    return db.getAllFromIndex('ide_connections', 'by-project', projectUid)
  }

  async getById(id: string): Promise<IdeConnection | undefined> {
    const db = await getDB()
    return db.get('ide_connections', id)
  }

  async create(connection: IdeConnection): Promise<void> {
    const db = await getDB()
    await db.add('ide_connections', connection)
  }

  async update(id: string, changes: Partial<IdeConnection>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('ide_connections', id)
    if (!existing) return
    await db.put('ide_connections', { ...existing, ...changes })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('ide_connections', id)
  }

  async deleteByProject(projectUid: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('ide_connections', 'by-project', projectUid)
    const tx = db.transaction('ide_connections', 'readwrite')
    for (const item of items) {
      tx.store.delete(item.id)
    }
    await tx.done
  }
}

class IDBIdeFileStorage implements IdeFileStorage {
  async getByProject(projectUid: string): Promise<IdeFile[]> {
    const db = await getDB()
    return db.getAllFromIndex('ide_files', 'by-project', projectUid)
  }

  async getById(id: string): Promise<IdeFile | undefined> {
    const db = await getDB()
    return db.get('ide_files', id)
  }

  async create(file: IdeFile): Promise<void> {
    const db = await getDB()
    await db.add('ide_files', file)
  }

  async update(id: string, changes: Partial<IdeFile>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('ide_files', id)
    if (!existing) return
    await db.put('ide_files', { ...existing, ...changes })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('ide_files', id)
  }

  async deleteByProject(projectUid: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('ide_files', 'by-project', projectUid)
    const tx = db.transaction('ide_files', 'readwrite')
    for (const item of items) {
      tx.store.delete(item.id)
    }
    await tx.done
  }
}

class IDBDatasetFileStorage implements DatasetFileStorage {
  async getByProject(projectUid: string): Promise<DatasetFile[]> {
    const db = await getDB()
    return db.getAllFromIndex('dataset_files', 'by-project', projectUid)
  }

  async getById(id: string): Promise<DatasetFile | undefined> {
    const db = await getDB()
    return db.get('dataset_files', id)
  }

  async create(file: DatasetFile): Promise<void> {
    const db = await getDB()
    await db.add('dataset_files', file)
  }

  async update(id: string, changes: Partial<DatasetFile>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('dataset_files', id)
    if (!existing) return
    await db.put('dataset_files', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('dataset_files', id)
  }

  async deleteByProject(projectUid: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('dataset_files', 'by-project', projectUid)
    const tx = db.transaction('dataset_files', 'readwrite')
    for (const item of items) {
      tx.store.delete(item.id)
    }
    await tx.done
  }
}

class IDBDatasetDataStorage implements DatasetDataStorage {
  async get(datasetFileId: string): Promise<DatasetData | undefined> {
    const db = await getDB()
    return db.get('dataset_data', datasetFileId)
  }

  async save(data: DatasetData): Promise<void> {
    const db = await getDB()
    await db.put('dataset_data', data)
  }

  async delete(datasetFileId: string): Promise<void> {
    const db = await getDB()
    await db.delete('dataset_data', datasetFileId)
  }
}

class IDBDatasetAnalysisStorage implements DatasetAnalysisStorage {
  async getByDataset(datasetFileId: string): Promise<DatasetAnalysis[]> {
    const db = await getDB()
    return db.getAllFromIndex('dataset_analyses', 'by-dataset', datasetFileId)
  }

  async getById(id: string): Promise<DatasetAnalysis | undefined> {
    const db = await getDB()
    return db.get('dataset_analyses', id)
  }

  async create(analysis: DatasetAnalysis): Promise<void> {
    const db = await getDB()
    await db.add('dataset_analyses', analysis)
  }

  async update(id: string, changes: Partial<DatasetAnalysis>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('dataset_analyses', id)
    if (!existing) return
    await db.put('dataset_analyses', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('dataset_analyses', id)
  }

  async deleteByDataset(datasetFileId: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('dataset_analyses', 'by-dataset', datasetFileId)
    const tx = db.transaction('dataset_analyses', 'readwrite')
    for (const item of items) {
      tx.store.delete(item.id)
    }
    await tx.done
  }
}

class IDBUserPluginStorage implements UserPluginStorage {
  async getAll(): Promise<UserPlugin[]> {
    const db = await getDB()
    return db.getAll('user_plugins')
  }

  async getById(id: string): Promise<UserPlugin | undefined> {
    const db = await getDB()
    return db.get('user_plugins', id)
  }

  async create(plugin: UserPlugin): Promise<void> {
    const db = await getDB()
    await db.add('user_plugins', plugin)
  }

  async update(id: string, changes: Partial<UserPlugin>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('user_plugins', id)
    if (!existing) return
    await db.put('user_plugins', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('user_plugins', id)
  }
}

class IDBDashboardStorage implements DashboardStorage {
  async getByProject(projectUid: string): Promise<Dashboard[]> {
    const db = await getDB()
    return db.getAllFromIndex('dashboards', 'by-project', projectUid)
  }

  async getById(id: string): Promise<Dashboard | undefined> {
    const db = await getDB()
    return db.get('dashboards', id)
  }

  async create(dashboard: Dashboard): Promise<void> {
    const db = await getDB()
    await db.add('dashboards', dashboard)
  }

  async update(id: string, changes: Partial<Dashboard>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('dashboards', id)
    if (!existing) return
    await db.put('dashboards', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('dashboards', id)
  }
}

class IDBDashboardTabStorage implements DashboardTabStorage {
  async getByDashboard(dashboardId: string): Promise<DashboardTab[]> {
    const db = await getDB()
    return db.getAllFromIndex('dashboard_tabs', 'by-dashboard', dashboardId)
  }

  async getById(id: string): Promise<DashboardTab | undefined> {
    const db = await getDB()
    return db.get('dashboard_tabs', id)
  }

  async create(tab: DashboardTab): Promise<void> {
    const db = await getDB()
    await db.add('dashboard_tabs', tab)
  }

  async update(id: string, changes: Partial<DashboardTab>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('dashboard_tabs', id)
    if (!existing) return
    await db.put('dashboard_tabs', { ...existing, ...changes })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('dashboard_tabs', id)
  }

  async deleteByDashboard(dashboardId: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('dashboard_tabs', 'by-dashboard', dashboardId)
    const tx = db.transaction('dashboard_tabs', 'readwrite')
    for (const item of items) {
      tx.store.delete(item.id)
    }
    await tx.done
  }
}

class IDBDashboardWidgetStorage implements DashboardWidgetStorage {
  async getByTab(tabId: string): Promise<DashboardWidget[]> {
    const db = await getDB()
    return db.getAllFromIndex('dashboard_widgets', 'by-tab', tabId)
  }

  async getById(id: string): Promise<DashboardWidget | undefined> {
    const db = await getDB()
    return db.get('dashboard_widgets', id)
  }

  async create(widget: DashboardWidget): Promise<void> {
    const db = await getDB()
    await db.add('dashboard_widgets', widget)
  }

  async update(id: string, changes: Partial<DashboardWidget>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('dashboard_widgets', id)
    if (!existing) return
    await db.put('dashboard_widgets', { ...existing, ...changes })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('dashboard_widgets', id)
  }

  async deleteByTab(tabId: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('dashboard_widgets', 'by-tab', tabId)
    const tx = db.transaction('dashboard_widgets', 'readwrite')
    for (const item of items) {
      tx.store.delete(item.id)
    }
    await tx.done
  }
}

export function createIDBStorage(): Storage {
  return {
    organizations: new IDBOrganizationStorage(),
    workspaces: new IDBWorkspaceStorage(),
    projects: new IDBProjectStorage(),
    dataSources: new IDBDataSourceStorage(),
    files: new IDBFileStorage(),
    fileHandles: new IDBFileHandleStorage(),
    cohorts: new IDBCohortStorage(),
    databaseStatsCache: new IDBDatabaseStatsCacheStorage(),
    schemaPresets: new IDBSchemaPresetStorage(),
    pipelines: new IDBPipelineStorage(),
    readmeAttachments: new IDBReadmeAttachmentStorage(),
    connections: new IDBConnectionStorage(),
    ideFiles: new IDBIdeFileStorage(),
    datasetFiles: new IDBDatasetFileStorage(),
    datasetData: new IDBDatasetDataStorage(),
    datasetAnalyses: new IDBDatasetAnalysisStorage(),
    userPlugins: new IDBUserPluginStorage(),
    dashboards: new IDBDashboardStorage(),
    dashboardTabs: new IDBDashboardTabStorage(),
    dashboardWidgets: new IDBDashboardWidgetStorage(),
  }
}
