import type { Project, DataSource, StoredFile, StoredFileHandle, Cohort, DatabaseStatsCache, Pipeline, ReadmeAttachment, CustomSchemaPreset, IdeConnection, IdeFile, DatasetFile, DatasetData, DatasetAnalysis, UserPlugin } from '@/types'

/** Storage interface for project persistence. */
export interface ProjectStorage {
  getAll(): Promise<Project[]>
  getById(uid: string): Promise<Project | undefined>
  create(project: Project): Promise<void>
  update(uid: string, changes: Partial<Project>): Promise<void>
  delete(uid: string): Promise<void>
}

/** Storage interface for data source persistence. */
export interface DataSourceStorage {
  getAll(): Promise<DataSource[]>
  getByProject(projectUid: string): Promise<DataSource[]>
  getById(id: string): Promise<DataSource | undefined>
  create(dataSource: DataSource): Promise<void>
  update(id: string, changes: Partial<DataSource>): Promise<void>
  delete(id: string): Promise<void>
}

/** Storage interface for uploaded file blobs. */
export interface FileStorage {
  getByDataSource(dataSourceId: string): Promise<StoredFile[]>
  getById(id: string): Promise<StoredFile | undefined>
  create(file: StoredFile): Promise<void>
  delete(id: string): Promise<void>
  deleteByDataSource(dataSourceId: string): Promise<void>
}

/** Storage interface for cohort persistence. */
export interface CohortStorage {
  getAll(): Promise<Cohort[]>
  getByProject(projectUid: string): Promise<Cohort[]>
  getById(id: string): Promise<Cohort | undefined>
  create(cohort: Cohort): Promise<void>
  update(id: string, changes: Partial<Cohort>): Promise<void>
  delete(id: string): Promise<void>
}

/** Storage interface for database stats cache. */
export interface DatabaseStatsCacheStorage {
  get(dataSourceId: string): Promise<DatabaseStatsCache | undefined>
  save(cache: DatabaseStatsCache): Promise<void>
  delete(dataSourceId: string): Promise<void>
}

/** Storage interface for readme attachment blobs. */
export interface ReadmeAttachmentStorage {
  getByProject(projectUid: string): Promise<ReadmeAttachment[]>
  getById(id: string): Promise<ReadmeAttachment | undefined>
  create(attachment: ReadmeAttachment): Promise<void>
  delete(id: string): Promise<void>
  deleteByProject(projectUid: string): Promise<void>
}

/** Storage interface for File System Access API file handles (zero-copy). */
export interface FileHandleStorage {
  getByDataSource(dataSourceId: string): Promise<StoredFileHandle[]>
  create(handle: StoredFileHandle): Promise<void>
  deleteByDataSource(dataSourceId: string): Promise<void>
}

/** Storage interface for custom schema presets. */
export interface SchemaPresetStorage {
  getAll(): Promise<CustomSchemaPreset[]>
  getById(presetId: string): Promise<CustomSchemaPreset | undefined>
  save(preset: CustomSchemaPreset): Promise<void>
  delete(presetId: string): Promise<void>
}

/** Storage interface for pipeline persistence. */
export interface PipelineStorage {
  getAll(): Promise<Pipeline[]>
  getByProject(projectUid: string): Promise<Pipeline[]>
  getById(id: string): Promise<Pipeline | undefined>
  create(pipeline: Pipeline): Promise<void>
  update(id: string, changes: Partial<Pipeline>): Promise<void>
  delete(id: string): Promise<void>
}

/** Storage interface for IDE connections. */
export interface ConnectionStorage {
  getByProject(projectUid: string): Promise<IdeConnection[]>
  getById(id: string): Promise<IdeConnection | undefined>
  create(connection: IdeConnection): Promise<void>
  update(id: string, changes: Partial<IdeConnection>): Promise<void>
  delete(id: string): Promise<void>
  deleteByProject(projectUid: string): Promise<void>
}

/** Storage interface for IDE code files. */
export interface IdeFileStorage {
  getByProject(projectUid: string): Promise<IdeFile[]>
  getById(id: string): Promise<IdeFile | undefined>
  create(file: IdeFile): Promise<void>
  update(id: string, changes: Partial<IdeFile>): Promise<void>
  delete(id: string): Promise<void>
  deleteByProject(projectUid: string): Promise<void>
}

/** Storage interface for dataset file tree entries. */
export interface DatasetFileStorage {
  getByProject(projectUid: string): Promise<DatasetFile[]>
  getById(id: string): Promise<DatasetFile | undefined>
  create(file: DatasetFile): Promise<void>
  update(id: string, changes: Partial<DatasetFile>): Promise<void>
  delete(id: string): Promise<void>
  deleteByProject(projectUid: string): Promise<void>
}

/** Storage interface for dataset row data (heavy, gitignored). */
export interface DatasetDataStorage {
  get(datasetFileId: string): Promise<DatasetData | undefined>
  save(data: DatasetData): Promise<void>
  delete(datasetFileId: string): Promise<void>
}

/** Storage interface for dataset analysis configs (lightweight, versioned). */
export interface DatasetAnalysisStorage {
  getByDataset(datasetFileId: string): Promise<DatasetAnalysis[]>
  getById(id: string): Promise<DatasetAnalysis | undefined>
  create(analysis: DatasetAnalysis): Promise<void>
  update(id: string, changes: Partial<DatasetAnalysis>): Promise<void>
  delete(id: string): Promise<void>
  deleteByDataset(datasetFileId: string): Promise<void>
}

/** Storage interface for user-created plugins. */
export interface UserPluginStorage {
  getAll(): Promise<UserPlugin[]>
  getById(id: string): Promise<UserPlugin | undefined>
  create(plugin: UserPlugin): Promise<void>
  update(id: string, changes: Partial<UserPlugin>): Promise<void>
  delete(id: string): Promise<void>
}

/** Top-level storage facade. Extensible for future entity types. */
export interface Storage {
  projects: ProjectStorage
  dataSources: DataSourceStorage
  files: FileStorage
  fileHandles: FileHandleStorage
  cohorts: CohortStorage
  databaseStatsCache: DatabaseStatsCacheStorage
  schemaPresets: SchemaPresetStorage
  pipelines: PipelineStorage
  readmeAttachments: ReadmeAttachmentStorage
  connections: ConnectionStorage
  ideFiles: IdeFileStorage
  datasetFiles: DatasetFileStorage
  datasetData: DatasetDataStorage
  datasetAnalyses: DatasetAnalysisStorage
  userPlugins: UserPluginStorage
}

let _storage: Storage | null = null

export function getStorage(): Storage {
  if (!_storage) throw new Error('Storage not initialized. Call initStorage() first.')
  return _storage
}

export function initStorage(storage: Storage): void {
  _storage = storage
}
