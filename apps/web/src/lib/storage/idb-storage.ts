import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Project, DataSource, StoredFile, StoredFileHandle, Cohort, DatabaseStatsCache, Pipeline, ReadmeAttachment, CustomSchemaPreset, IdeConnection, IdeFile, DatasetFile, DatasetData, DatasetRawFile, DatasetAnalysis, UserPlugin, Dashboard, DashboardTab, DashboardWidget, Workspace, Organization, WikiPage, WikiAttachment, EtlPipeline, EtlFile, DqRuleSet, DqCustomCheck, ConceptSet, MappingProject, ConceptMapping, DataCatalog, CatalogResultCache, ServiceMapping, SqlScriptCollection, SqlScriptFile, SourceConceptIdRange, SourceConceptIdEntry } from '@/types'
import type { Storage, OrganizationStorage, WorkspaceStorage, ProjectStorage, DataSourceStorage, FileStorage, FileHandleStorage, CohortStorage, DatabaseStatsCacheStorage, SchemaPresetStorage, PipelineStorage, ReadmeAttachmentStorage, ConnectionStorage, IdeFileStorage, DatasetFileStorage, DatasetDataStorage, DatasetRawFileStorage, DatasetAnalysisStorage, UserPluginStorage, DashboardStorage, DashboardTabStorage, DashboardWidgetStorage, WikiPageStorage, WikiAttachmentStorage, EtlPipelineStorage, EtlFileStorage, SqlScriptCollectionStorage, SqlScriptFileStorage, DqRuleSetStorage, DqCustomCheckStorage, ConceptSetStorage, MappingProjectStorage, ConceptMappingStorage, DataCatalogStorage, CatalogResultStorage, ServiceMappingStorage, SourceConceptIdRangeStorage, SourceConceptIdEntryStorage } from './index'
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
      'by-workspace': string
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
    indexes: {
      'by-workspace': string
    }
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
  dataset_raw_files: {
    key: string
    value: DatasetRawFile
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
    indexes: {
      'by-workspace': string
    }
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
  wiki_pages: {
    key: string
    value: WikiPage
    indexes: {
      'by-workspace': string
      'by-parent': string
    }
  }
  wiki_attachments: {
    key: string
    value: WikiAttachment
    indexes: {
      'by-page': string
      'by-workspace': string
    }
  }
  etl_pipelines: {
    key: string
    value: EtlPipeline
    indexes: {
      'by-workspace': string
    }
  }
  etl_files: {
    key: string
    value: EtlFile
    indexes: {
      'by-pipeline': string
    }
  }
  sql_script_collections: {
    key: string
    value: SqlScriptCollection
    indexes: {
      'by-workspace': string
    }
  }
  sql_script_files: {
    key: string
    value: SqlScriptFile
    indexes: {
      'by-collection': string
    }
  }
  dq_rule_sets: {
    key: string
    value: DqRuleSet
    indexes: {
      'by-workspace': string
    }
  }
  dq_custom_checks: {
    key: string
    value: DqCustomCheck
    indexes: {
      'by-rule-set': string
    }
  }
  concept_sets: {
    key: string
    value: ConceptSet
    indexes: {
      'by-workspace': string
    }
  }
  mapping_projects: {
    key: string
    value: MappingProject
    indexes: {
      'by-workspace': string
    }
  }
  concept_mappings: {
    key: string
    value: ConceptMapping
    indexes: {
      'by-project': string
    }
  }
  data_catalogs: {
    key: string
    value: DataCatalog
    indexes: {
      'by-workspace': string
    }
  }
  catalog_results: {
    key: string
    value: CatalogResultCache
  }
  service_mappings: {
    key: string
    value: ServiceMapping
    indexes: {
      'by-workspace': string
    }
  }
  source_concept_id_ranges: {
    /** Composite key: `${workspaceId}__${badgeLabel}` */
    key: string
    value: SourceConceptIdRange
    indexes: {
      'by-workspace': string
    }
  }
  source_concept_id_entries: {
    /** Composite key: `${workspaceId}__${badgeLabel}__${vocabularyId}__${conceptCode}` */
    key: string
    value: SourceConceptIdEntry
    indexes: {
      'by-workspace-badge': string
      'by-workspace': string
    }
  }
}

const DB_NAME = 'linkr'
const DB_VERSION = 29

let _dbPromise: Promise<IDBPDatabase<LinkrDB>> | null = null

function getDB(): Promise<IDBPDatabase<LinkrDB>> {
  if (_dbPromise) return _dbPromise
  _dbPromise = openDB<LinkrDB>(DB_NAME, DB_VERSION, {
    blocked(_currentVersion, _blockedVersion, event) {
      // Another tab has the DB open at an older version — ask it to close
      ;(event.target as IDBOpenDBRequest)?.result?.close?.()
    },
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
      // Version 18: Wiki pages and attachments
      if (oldVersion < 18) {
        const wikiPageStore = db.createObjectStore('wiki_pages', { keyPath: 'id' })
        wikiPageStore.createIndex('by-workspace', 'workspaceId')
        wikiPageStore.createIndex('by-parent', 'parentId')
        const wikiAttStore = db.createObjectStore('wiki_attachments', { keyPath: 'id' })
        wikiAttStore.createIndex('by-page', 'pageId')
        wikiAttStore.createIndex('by-workspace', 'workspaceId')
      }
      // Version 19: Raw source files for dataset re-import
      if (oldVersion < 19) {
        db.createObjectStore('dataset_raw_files', { keyPath: 'datasetFileId' })
      }
      // Version 20: ETL pipelines and files
      if (oldVersion < 20) {
        const etlPipelineStore = db.createObjectStore('etl_pipelines', { keyPath: 'id' })
        etlPipelineStore.createIndex('by-workspace', 'workspaceId')
        const etlFileStore = db.createObjectStore('etl_files', { keyPath: 'id' })
        etlFileStore.createIndex('by-pipeline', 'pipelineId')
      }
      // Version 21: Data Quality rule sets and custom checks
      if (oldVersion < 21) {
        const dqRuleSetStore = db.createObjectStore('dq_rule_sets', { keyPath: 'id' })
        dqRuleSetStore.createIndex('by-workspace', 'workspaceId')
        const dqCheckStore = db.createObjectStore('dq_custom_checks', { keyPath: 'id' })
        dqCheckStore.createIndex('by-rule-set', 'ruleSetId')
      }
      // Version 22: Rename dq_suites → dq_rule_sets (if upgrading from 21)
      if (oldVersion === 21) {
        if (db.objectStoreNames.contains('dq_suites')) {
          db.deleteObjectStore('dq_suites')
        }
        if (db.objectStoreNames.contains('dq_custom_checks')) {
          db.deleteObjectStore('dq_custom_checks')
        }
        const dqRuleSetStore = db.createObjectStore('dq_rule_sets', { keyPath: 'id' })
        dqRuleSetStore.createIndex('by-workspace', 'workspaceId')
        const dqCheckStore = db.createObjectStore('dq_custom_checks', { keyPath: 'id' })
        dqCheckStore.createIndex('by-rule-set', 'ruleSetId')
      }
      // Version 23: Concept mapping (concept sets, mapping projects, concept mappings)
      if (oldVersion < 23) {
        const csStore = db.createObjectStore('concept_sets', { keyPath: 'id' })
        csStore.createIndex('by-workspace', 'workspaceId')
        const mpStore = db.createObjectStore('mapping_projects', { keyPath: 'id' })
        mpStore.createIndex('by-workspace', 'workspaceId')
        const cmStore = db.createObjectStore('concept_mappings', { keyPath: 'id' })
        cmStore.createIndex('by-project', 'projectId')
      }
      // Version 24: Data catalogs, catalog results, service mappings
      if (oldVersion < 24) {
        const dcStore = db.createObjectStore('data_catalogs', { keyPath: 'id' })
        dcStore.createIndex('by-workspace', 'workspaceId')
        db.createObjectStore('catalog_results', { keyPath: 'catalogId' })
        const smStore = db.createObjectStore('service_mappings', { keyPath: 'id' })
        smStore.createIndex('by-workspace', 'workspaceId')
      }
      // Version 25: Move datasetFileId from dashboards to widgets, new filter format
      if (oldVersion < 25 && oldVersion >= 15) {
        const dashStore = transaction.objectStore('dashboards')
        const tabStore = transaction.objectStore('dashboard_tabs')
        const widgetStore = transaction.objectStore('dashboard_widgets')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(dashStore.getAll() as Promise<any[]>).then(async (dashboards) => {
          for (const dash of dashboards) {
            const datasetFileId = dash.datasetFileId ?? null
            // Migrate widgets: copy datasetFileId from dashboard to each widget
            if (datasetFileId) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const tabs = await (tabStore.index('by-dashboard').getAll(dash.id) as Promise<any[]>)
              for (const tab of tabs) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const widgets = await (widgetStore.index('by-tab').getAll(tab.id) as Promise<any[]>)
                for (const widget of widgets) {
                  if (!widget.datasetFileId) {
                    widget.datasetFileId = datasetFileId
                    widgetStore.put(widget)
                  }
                }
              }
            }
            // Convert old filterConfig (DashboardFilterColumn[]) to new DashboardFilter[]
            const oldFilters = dash.filterConfig ?? []
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            dash.filterConfig = oldFilters.map((fc: any, i: number) => {
              const type = fc.type ?? 'categorical'
              return {
                id: `df-migrated-${i}`,
                datasetFileId: datasetFileId ?? '',
                columnId: fc.columnId,
                columnName: fc.label ?? fc.columnId,
                type,
                inputType: type === 'categorical' ? 'multi-select' : 'range',
                propagate: false,
              }
            })
            // Remove datasetFileId from dashboard
            delete dash.datasetFileId
            dashStore.put(dash)
          }
        })
      }
      // Version 26: Scope user_plugins, schema_presets, data_sources by workspace
      if (oldVersion < 26) {
        // Add by-workspace index to user_plugins
        if (oldVersion >= 14) {
          const pluginStore = transaction.objectStore('user_plugins')
          if (!pluginStore.indexNames.contains('by-workspace')) {
            pluginStore.createIndex('by-workspace', 'workspaceId')
          }
        }
        // Add by-workspace index to schema_presets
        if (oldVersion >= 8) {
          const presetStore = transaction.objectStore('schema_presets')
          if (!presetStore.indexNames.contains('by-workspace')) {
            presetStore.createIndex('by-workspace', 'workspaceId')
          }
        }
        // Add by-workspace index to data_sources
        if (oldVersion >= 2) {
          const dsStore = transaction.objectStore('data_sources')
          if (!dsStore.indexNames.contains('by-workspace')) {
            dsStore.createIndex('by-workspace', 'workspaceId')
          }
        }
        // Migrate existing records: stamp workspaceId from first workspace
        if (oldVersion >= 16) {
          const wsStore = transaction.objectStore('workspaces')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(wsStore.getAll() as Promise<any[]>).then((workspaces) => {
            const firstWsId = workspaces.length > 0 ? workspaces[0].id : undefined
            if (!firstWsId) return
            // Stamp user_plugins
            if (oldVersion >= 14) {
              const pluginStore = transaction.objectStore('user_plugins')
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ;(pluginStore.getAll() as Promise<any[]>).then((plugins) => {
                for (const p of plugins) {
                  if (!p.workspaceId) {
                    p.workspaceId = firstWsId
                    pluginStore.put(p)
                  }
                }
              })
            }
            // Stamp schema_presets
            if (oldVersion >= 8) {
              const presetStore = transaction.objectStore('schema_presets')
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ;(presetStore.getAll() as Promise<any[]>).then((presets) => {
                for (const p of presets) {
                  if (!p.workspaceId) {
                    p.workspaceId = firstWsId
                    presetStore.put(p)
                  }
                }
              })
            }
            // Stamp data_sources
            if (oldVersion >= 2) {
              const dsStore = transaction.objectStore('data_sources')
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ;(dsStore.getAll() as Promise<any[]>).then((sources) => {
                for (const ds of sources) {
                  if (!ds.workspaceId) {
                    ds.workspaceId = firstWsId
                    dsStore.put(ds)
                  }
                }
              })
            }
          })
        }
      }
      // Version 27: SQL script collections and files
      if (oldVersion < 27) {
        const collStore = db.createObjectStore('sql_script_collections', { keyPath: 'id' })
        collStore.createIndex('by-workspace', 'workspaceId')
        const fileStore = db.createObjectStore('sql_script_files', { keyPath: 'id' })
        fileStore.createIndex('by-collection', 'collectionId')
      }
      // Version 28: Ensure by-workspace indexes exist (fixes v27 fresh installs that skipped v26 migration)
      if (oldVersion < 28) {
        const ensureIndex = (storeName: string, indexName: string, keyPath: string) => {
          try {
            const store = transaction.objectStore(storeName as never)
            if (!store.indexNames.contains(indexName)) {
              store.createIndex(indexName, keyPath)
            }
          } catch { /* store might not exist yet */ }
        }
        ensureIndex('user_plugins', 'by-workspace', 'workspaceId')
        ensureIndex('schema_presets', 'by-workspace', 'workspaceId')
        ensureIndex('data_sources', 'by-workspace', 'workspaceId')

        // Stamp existing records that don't have workspaceId yet
        try {
          const wsStore = transaction.objectStore('workspaces')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(wsStore.getAll() as Promise<any[]>).then((workspaces) => {
            const firstWsId = workspaces.length > 0 ? workspaces[0].id : undefined
            if (!firstWsId) return
            const stampRecords = (storeName: string) => {
              try {
                const store = transaction.objectStore(storeName as never)
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ;(store.getAll() as Promise<any[]>).then((records) => {
                  for (const r of records) {
                    if (!r.workspaceId) {
                      r.workspaceId = firstWsId
                      store.put(r)
                    }
                  }
                })
              } catch { /* store might not exist */ }
            }
            stampRecords('user_plugins')
            stampRecords('schema_presets')
            stampRecords('data_sources')
          })
        } catch { /* workspaces store might not exist */ }
      }
      // Version 29: Source concept ID registry (OMOP custom IDs > 2B)
      if (oldVersion < 29) {
        const rangeStore = db.createObjectStore('source_concept_id_ranges', { keyPath: 'id' })
        rangeStore.createIndex('by-workspace', 'workspaceId')
        const entryStore = db.createObjectStore('source_concept_id_entries', { keyPath: 'id' })
        entryStore.createIndex('by-workspace-badge', 'workspaceBadgeKey')
        entryStore.createIndex('by-workspace', 'workspaceId')
      }
    },
  })
  // Auto-close when another tab requests a deleteDatabase or version upgrade
  _dbPromise.then((db) => {
    db.addEventListener('versionchange', () => {
      db.close()
      _dbPromise = null
    })
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

  async getByWorkspace(workspaceId: string): Promise<DataSource[]> {
    const db = await getDB()
    return db.getAllFromIndex('data_sources', 'by-workspace', workspaceId)
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

  async getByWorkspace(workspaceId: string): Promise<CustomSchemaPreset[]> {
    const db = await getDB()
    return db.getAllFromIndex('schema_presets', 'by-workspace', workspaceId)
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
    // Use put (upsert) instead of add to handle ID collisions gracefully
    // (e.g. after HMR resets the in-memory fileCounter)
    await db.put('ide_files', file)
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

class IDBDatasetRawFileStorage implements DatasetRawFileStorage {
  async get(datasetFileId: string): Promise<DatasetRawFile | undefined> {
    const db = await getDB()
    return db.get('dataset_raw_files', datasetFileId)
  }

  async save(data: DatasetRawFile): Promise<void> {
    const db = await getDB()
    await db.put('dataset_raw_files', data)
  }

  async delete(datasetFileId: string): Promise<void> {
    const db = await getDB()
    await db.delete('dataset_raw_files', datasetFileId)
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

  async getByWorkspace(workspaceId: string): Promise<UserPlugin[]> {
    const db = await getDB()
    return db.getAllFromIndex('user_plugins', 'by-workspace', workspaceId)
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

class IDBWikiPageStorage implements WikiPageStorage {
  async getByWorkspace(workspaceId: string): Promise<WikiPage[]> {
    const db = await getDB()
    return db.getAllFromIndex('wiki_pages', 'by-workspace', workspaceId)
  }

  async getById(id: string): Promise<WikiPage | undefined> {
    const db = await getDB()
    return db.get('wiki_pages', id)
  }

  async create(page: WikiPage): Promise<void> {
    const db = await getDB()
    await db.put('wiki_pages', page)
  }

  async update(id: string, changes: Partial<WikiPage>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('wiki_pages', id)
    if (!existing) return
    await db.put('wiki_pages', { ...existing, ...changes })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('wiki_pages', id)
  }

  async deleteByWorkspace(workspaceId: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('wiki_pages', 'by-workspace', workspaceId)
    const tx = db.transaction('wiki_pages', 'readwrite')
    for (const item of items) {
      tx.store.delete(item.id)
    }
    await tx.done
  }
}

class IDBWikiAttachmentStorage implements WikiAttachmentStorage {
  async getByPage(pageId: string): Promise<WikiAttachment[]> {
    const db = await getDB()
    return db.getAllFromIndex('wiki_attachments', 'by-page', pageId)
  }

  async getByWorkspace(workspaceId: string): Promise<WikiAttachment[]> {
    const db = await getDB()
    return db.getAllFromIndex('wiki_attachments', 'by-workspace', workspaceId)
  }

  async getById(id: string): Promise<WikiAttachment | undefined> {
    const db = await getDB()
    return db.get('wiki_attachments', id)
  }

  async create(attachment: WikiAttachment): Promise<void> {
    const db = await getDB()
    await db.put('wiki_attachments', attachment)
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('wiki_attachments', id)
  }

  async deleteByPage(pageId: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('wiki_attachments', 'by-page', pageId)
    const tx = db.transaction('wiki_attachments', 'readwrite')
    for (const item of items) {
      tx.store.delete(item.id)
    }
    await tx.done
  }

  async deleteByWorkspace(workspaceId: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('wiki_attachments', 'by-workspace', workspaceId)
    const tx = db.transaction('wiki_attachments', 'readwrite')
    for (const item of items) {
      tx.store.delete(item.id)
    }
    await tx.done
  }
}

class IDBEtlPipelineStorage implements EtlPipelineStorage {
  async getAll(): Promise<EtlPipeline[]> {
    const db = await getDB()
    return db.getAll('etl_pipelines')
  }

  async getByWorkspace(workspaceId: string): Promise<EtlPipeline[]> {
    const db = await getDB()
    return db.getAllFromIndex('etl_pipelines', 'by-workspace', workspaceId)
  }

  async getById(id: string): Promise<EtlPipeline | undefined> {
    const db = await getDB()
    return db.get('etl_pipelines', id)
  }

  async create(pipeline: EtlPipeline): Promise<void> {
    const db = await getDB()
    await db.add('etl_pipelines', pipeline)
  }

  async update(id: string, changes: Partial<EtlPipeline>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('etl_pipelines', id)
    if (!existing) return
    await db.put('etl_pipelines', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('etl_pipelines', id)
  }
}

class IDBEtlFileStorage implements EtlFileStorage {
  async getByPipeline(pipelineId: string): Promise<EtlFile[]> {
    const db = await getDB()
    return db.getAllFromIndex('etl_files', 'by-pipeline', pipelineId)
  }

  async getById(id: string): Promise<EtlFile | undefined> {
    const db = await getDB()
    return db.get('etl_files', id)
  }

  async create(file: EtlFile): Promise<void> {
    const db = await getDB()
    await db.add('etl_files', file)
  }

  async update(id: string, changes: Partial<EtlFile>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('etl_files', id)
    if (!existing) return
    await db.put('etl_files', { ...existing, ...changes })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('etl_files', id)
  }

  async deleteByPipeline(pipelineId: string): Promise<void> {
    const db = await getDB()
    const files = await db.getAllFromIndex('etl_files', 'by-pipeline', pipelineId)
    const tx = db.transaction('etl_files', 'readwrite')
    for (const file of files) {
      tx.store.delete(file.id)
    }
    await tx.done
  }
}

class IDBSqlScriptCollectionStorage implements SqlScriptCollectionStorage {
  async getAll(): Promise<SqlScriptCollection[]> {
    const db = await getDB()
    return db.getAll('sql_script_collections')
  }

  async getByWorkspace(workspaceId: string): Promise<SqlScriptCollection[]> {
    const db = await getDB()
    return db.getAllFromIndex('sql_script_collections', 'by-workspace', workspaceId)
  }

  async getById(id: string): Promise<SqlScriptCollection | undefined> {
    const db = await getDB()
    return db.get('sql_script_collections', id)
  }

  async create(collection: SqlScriptCollection): Promise<void> {
    const db = await getDB()
    await db.add('sql_script_collections', collection)
  }

  async update(id: string, changes: Partial<SqlScriptCollection>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('sql_script_collections', id)
    if (!existing) return
    await db.put('sql_script_collections', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('sql_script_collections', id)
  }
}

class IDBSqlScriptFileStorage implements SqlScriptFileStorage {
  async getByCollection(collectionId: string): Promise<SqlScriptFile[]> {
    const db = await getDB()
    return db.getAllFromIndex('sql_script_files', 'by-collection', collectionId)
  }

  async getById(id: string): Promise<SqlScriptFile | undefined> {
    const db = await getDB()
    return db.get('sql_script_files', id)
  }

  async create(file: SqlScriptFile): Promise<void> {
    const db = await getDB()
    await db.add('sql_script_files', file)
  }

  async update(id: string, changes: Partial<SqlScriptFile>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('sql_script_files', id)
    if (!existing) return
    await db.put('sql_script_files', { ...existing, ...changes })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('sql_script_files', id)
  }

  async deleteByCollection(collectionId: string): Promise<void> {
    const db = await getDB()
    const files = await db.getAllFromIndex('sql_script_files', 'by-collection', collectionId)
    const tx = db.transaction('sql_script_files', 'readwrite')
    for (const file of files) {
      tx.store.delete(file.id)
    }
    await tx.done
  }
}

class IDBDqRuleSetStorage implements DqRuleSetStorage {
  async getAll(): Promise<DqRuleSet[]> {
    const db = await getDB()
    return db.getAll('dq_rule_sets')
  }

  async getByWorkspace(workspaceId: string): Promise<DqRuleSet[]> {
    const db = await getDB()
    return db.getAllFromIndex('dq_rule_sets', 'by-workspace', workspaceId)
  }

  async getById(id: string): Promise<DqRuleSet | undefined> {
    const db = await getDB()
    return db.get('dq_rule_sets', id)
  }

  async create(ruleSet: DqRuleSet): Promise<void> {
    const db = await getDB()
    await db.add('dq_rule_sets', ruleSet)
  }

  async update(id: string, changes: Partial<DqRuleSet>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('dq_rule_sets', id)
    if (!existing) return
    await db.put('dq_rule_sets', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('dq_rule_sets', id)
  }
}

class IDBDqCustomCheckStorage implements DqCustomCheckStorage {
  async getByRuleSet(ruleSetId: string): Promise<DqCustomCheck[]> {
    const db = await getDB()
    return db.getAllFromIndex('dq_custom_checks', 'by-rule-set', ruleSetId)
  }

  async getById(id: string): Promise<DqCustomCheck | undefined> {
    const db = await getDB()
    return db.get('dq_custom_checks', id)
  }

  async create(check: DqCustomCheck): Promise<void> {
    const db = await getDB()
    await db.add('dq_custom_checks', check)
  }

  async update(id: string, changes: Partial<DqCustomCheck>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('dq_custom_checks', id)
    if (!existing) return
    await db.put('dq_custom_checks', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('dq_custom_checks', id)
  }

  async deleteByRuleSet(ruleSetId: string): Promise<void> {
    const db = await getDB()
    const checks = await db.getAllFromIndex('dq_custom_checks', 'by-rule-set', ruleSetId)
    const tx = db.transaction('dq_custom_checks', 'readwrite')
    for (const check of checks) {
      tx.store.delete(check.id)
    }
    await tx.done
  }
}

class IDBConceptSetStorage implements ConceptSetStorage {
  async getAll(): Promise<ConceptSet[]> {
    const db = await getDB()
    return db.getAll('concept_sets')
  }

  async getByWorkspace(workspaceId: string): Promise<ConceptSet[]> {
    const db = await getDB()
    return db.getAllFromIndex('concept_sets', 'by-workspace', workspaceId)
  }

  async getById(id: string): Promise<ConceptSet | undefined> {
    const db = await getDB()
    return db.get('concept_sets', id)
  }

  async create(conceptSet: ConceptSet): Promise<void> {
    const db = await getDB()
    await db.add('concept_sets', conceptSet)
  }

  async update(id: string, changes: Partial<ConceptSet>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('concept_sets', id)
    if (!existing) return
    await db.put('concept_sets', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('concept_sets', id)
  }

  async deleteBatch(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const db = await getDB()
    const tx = db.transaction('concept_sets', 'readwrite')
    for (const id of ids) {
      tx.store.delete(id)
    }
    await tx.done
  }
}

class IDBMappingProjectStorage implements MappingProjectStorage {
  async getAll(): Promise<MappingProject[]> {
    const db = await getDB()
    return db.getAll('mapping_projects')
  }

  async getByWorkspace(workspaceId: string): Promise<MappingProject[]> {
    const db = await getDB()
    return db.getAllFromIndex('mapping_projects', 'by-workspace', workspaceId)
  }

  async getById(id: string): Promise<MappingProject | undefined> {
    const db = await getDB()
    return db.get('mapping_projects', id)
  }

  async create(project: MappingProject): Promise<void> {
    const db = await getDB()
    await db.add('mapping_projects', project)
  }

  async update(id: string, changes: Partial<MappingProject>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('mapping_projects', id)
    if (!existing) return
    await db.put('mapping_projects', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('mapping_projects', id)
  }
}

class IDBConceptMappingStorage implements ConceptMappingStorage {
  async getByProject(projectId: string): Promise<ConceptMapping[]> {
    const db = await getDB()
    return db.getAllFromIndex('concept_mappings', 'by-project', projectId)
  }

  async getById(id: string): Promise<ConceptMapping | undefined> {
    const db = await getDB()
    return db.get('concept_mappings', id)
  }

  async create(mapping: ConceptMapping): Promise<void> {
    const db = await getDB()
    await db.add('concept_mappings', mapping)
  }

  async createBatch(mappings: ConceptMapping[]): Promise<void> {
    const db = await getDB()
    const tx = db.transaction('concept_mappings', 'readwrite')
    for (const mapping of mappings) {
      tx.store.add(mapping)
    }
    await tx.done
  }

  async update(id: string, changes: Partial<ConceptMapping>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('concept_mappings', id)
    if (!existing) return
    await db.put('concept_mappings', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('concept_mappings', id)
  }

  async deleteByProject(projectId: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('concept_mappings', 'by-project', projectId)
    const tx = db.transaction('concept_mappings', 'readwrite')
    for (const item of items) {
      tx.store.delete(item.id)
    }
    await tx.done
  }
}

class IDBDataCatalogStorage implements DataCatalogStorage {
  async getAll(): Promise<DataCatalog[]> {
    const db = await getDB()
    return db.getAll('data_catalogs')
  }

  async getByWorkspace(workspaceId: string): Promise<DataCatalog[]> {
    const db = await getDB()
    return db.getAllFromIndex('data_catalogs', 'by-workspace', workspaceId)
  }

  async getById(id: string): Promise<DataCatalog | undefined> {
    const db = await getDB()
    return db.get('data_catalogs', id)
  }

  async create(catalog: DataCatalog): Promise<void> {
    const db = await getDB()
    await db.add('data_catalogs', catalog)
  }

  async update(id: string, changes: Partial<DataCatalog>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('data_catalogs', id)
    if (!existing) return
    await db.put('data_catalogs', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('data_catalogs', id)
  }
}

class IDBCatalogResultStorage implements CatalogResultStorage {
  async get(catalogId: string): Promise<CatalogResultCache | undefined> {
    const db = await getDB()
    return db.get('catalog_results', catalogId)
  }

  async save(cache: CatalogResultCache): Promise<void> {
    const db = await getDB()
    await db.put('catalog_results', cache)
  }

  async delete(catalogId: string): Promise<void> {
    const db = await getDB()
    await db.delete('catalog_results', catalogId)
  }
}

class IDBServiceMappingStorage implements ServiceMappingStorage {
  async getAll(): Promise<ServiceMapping[]> {
    const db = await getDB()
    return db.getAll('service_mappings')
  }

  async getByWorkspace(workspaceId: string): Promise<ServiceMapping[]> {
    const db = await getDB()
    return db.getAllFromIndex('service_mappings', 'by-workspace', workspaceId)
  }

  async getById(id: string): Promise<ServiceMapping | undefined> {
    const db = await getDB()
    return db.get('service_mappings', id)
  }

  async create(mapping: ServiceMapping): Promise<void> {
    const db = await getDB()
    await db.add('service_mappings', mapping)
  }

  async update(id: string, changes: Partial<ServiceMapping>): Promise<void> {
    const db = await getDB()
    const existing = await db.get('service_mappings', id)
    if (!existing) return
    await db.put('service_mappings', { ...existing, ...changes, updatedAt: new Date().toISOString() })
  }

  async delete(id: string): Promise<void> {
    const db = await getDB()
    await db.delete('service_mappings', id)
  }
}

class IDBSourceConceptIdRangeStorage implements SourceConceptIdRangeStorage {
  private rangeId(workspaceId: string, badgeLabel: string) {
    return `${workspaceId}__${badgeLabel}`
  }

  async getByWorkspace(workspaceId: string): Promise<SourceConceptIdRange[]> {
    const db = await getDB()
    return db.getAllFromIndex('source_concept_id_ranges', 'by-workspace', workspaceId)
  }

  async get(workspaceId: string, badgeLabel: string): Promise<SourceConceptIdRange | undefined> {
    const db = await getDB()
    return db.get('source_concept_id_ranges', this.rangeId(workspaceId, badgeLabel))
  }

  async save(range: SourceConceptIdRange): Promise<void> {
    const db = await getDB()
    const id = this.rangeId(range.workspaceId, range.badgeLabel)
    await db.put('source_concept_id_ranges', { ...range, id })
  }

  async delete(workspaceId: string, badgeLabel: string): Promise<void> {
    const db = await getDB()
    await db.delete('source_concept_id_ranges', this.rangeId(workspaceId, badgeLabel))
  }

  async deleteByWorkspace(workspaceId: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('source_concept_id_ranges', 'by-workspace', workspaceId)
    const tx = db.transaction('source_concept_id_ranges', 'readwrite')
    for (const item of items) tx.store.delete((item as SourceConceptIdRange & { id: string }).id)
    await tx.done
  }
}

class IDBSourceConceptIdEntryStorage implements SourceConceptIdEntryStorage {
  private workspaceBadgeKey(workspaceId: string, badgeLabel: string) {
    return `${workspaceId}__${badgeLabel}`
  }

  async getByWorkspace(workspaceId: string): Promise<SourceConceptIdEntry[]> {
    const db = await getDB()
    return db.getAllFromIndex('source_concept_id_entries', 'by-workspace', workspaceId)
  }

  async getByWorkspaceAndBadge(workspaceId: string, badgeLabel: string): Promise<SourceConceptIdEntry[]> {
    const db = await getDB()
    return db.getAllFromIndex('source_concept_id_entries', 'by-workspace-badge', this.workspaceBadgeKey(workspaceId, badgeLabel))
  }

  async get(id: string): Promise<SourceConceptIdEntry | undefined> {
    const db = await getDB()
    return db.get('source_concept_id_entries', id)
  }

  async save(entry: SourceConceptIdEntry): Promise<void> {
    const db = await getDB()
    const workspaceBadgeKey = this.workspaceBadgeKey(entry.workspaceId, entry.badgeLabel)
    await db.put('source_concept_id_entries', { ...entry, workspaceBadgeKey })
  }

  async deleteByWorkspaceAndBadge(workspaceId: string, badgeLabel: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('source_concept_id_entries', 'by-workspace-badge', this.workspaceBadgeKey(workspaceId, badgeLabel))
    const tx = db.transaction('source_concept_id_entries', 'readwrite')
    for (const item of items) tx.store.delete(item.id)
    await tx.done
  }

  async deleteByWorkspace(workspaceId: string): Promise<void> {
    const db = await getDB()
    const items = await db.getAllFromIndex('source_concept_id_entries', 'by-workspace', workspaceId)
    const tx = db.transaction('source_concept_id_entries', 'readwrite')
    for (const item of items) tx.store.delete(item.id)
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
    datasetRawFiles: new IDBDatasetRawFileStorage(),
    datasetAnalyses: new IDBDatasetAnalysisStorage(),
    userPlugins: new IDBUserPluginStorage(),
    dashboards: new IDBDashboardStorage(),
    dashboardTabs: new IDBDashboardTabStorage(),
    dashboardWidgets: new IDBDashboardWidgetStorage(),
    wikiPages: new IDBWikiPageStorage(),
    wikiAttachments: new IDBWikiAttachmentStorage(),
    etlPipelines: new IDBEtlPipelineStorage(),
    etlFiles: new IDBEtlFileStorage(),
    sqlScriptCollections: new IDBSqlScriptCollectionStorage(),
    sqlScriptFiles: new IDBSqlScriptFileStorage(),
    dqRuleSets: new IDBDqRuleSetStorage(),
    dqCustomChecks: new IDBDqCustomCheckStorage(),
    conceptSets: new IDBConceptSetStorage(),
    mappingProjects: new IDBMappingProjectStorage(),
    conceptMappings: new IDBConceptMappingStorage(),
    dataCatalogs: new IDBDataCatalogStorage(),
    catalogResults: new IDBCatalogResultStorage(),
    serviceMappings: new IDBServiceMappingStorage(),
    sourceConceptIdRanges: new IDBSourceConceptIdRangeStorage(),
    sourceConceptIdEntries: new IDBSourceConceptIdEntryStorage(),
  }
}
