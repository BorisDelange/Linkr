import {
  apiDatasetAnalysisStorage,
  apiDatasetDataStorage,
  apiDatasetFileStorage,
  apiDatasetRawFileStorage,
} from '@/lib/api/datasets'
import { apiCohortStorage } from '@/lib/api/cohorts'
import { apiConceptSetStorage } from '@/lib/api/concept-sets'
import { apiIdeConnectionStorage } from '@/lib/api/ide-connections'
import { apiUserPluginStorage } from '@/lib/api/user-plugins'
import { apiConceptMappingStorage, apiMappingProjectStorage, apiServiceMappingStorage } from '@/lib/api/mapping-projects'
import { apiSourceConceptIdEntryStorage, apiSourceConceptIdRangeStorage } from '@/lib/api/source-concept-ids'
import { apiDataCatalogStorage } from '@/lib/api/catalogs'
import { apiDataSourceStorage, apiFileStorage } from '@/lib/api/data-sources'
import { apiDqCustomCheckStorage, apiDqRuleSetStorage } from '@/lib/api/dq'
import { apiEtlFileStorage, apiEtlPipelineStorage } from '@/lib/api/etl'
import { apiIdeFileStorage } from '@/lib/api/ide-files'
import { apiOrganizationStorage } from '@/lib/api/organizations'
import { apiPipelineStorage } from '@/lib/api/pipelines'
import { apiProjectStorage } from '@/lib/api/projects'
import { apiRoleStorage } from '@/lib/api/roles'
import { apiSchemaPresetStorage } from '@/lib/api/schema-presets'
import { apiSqlScriptCollectionStorage, apiSqlScriptFileStorage } from '@/lib/api/sql-scripts'
import { apiUserStorage } from '@/lib/api/users'
import { apiWikiPageStorage } from '@/lib/api/wiki-pages'
import { apiWorkspaceStorage } from '@/lib/api/workspaces'
import type { Storage } from '@/lib/storage'
import { createIDBStorage } from '@/lib/storage/idb-storage'

/**
 * Server-mode Storage: API-backed where an adapter exists, IndexedDB otherwise.
 *
 * As each entity is migrated to the backend, add its API adapter to the override
 * list below; the IDB fallback shrinks until it only serves local (front-only) mode.
 */
export function createAPIStorage(): Storage {
  const idb = createIDBStorage()
  return {
    ...idb,
    workspaces: apiWorkspaceStorage,
    users: apiUserStorage,
    roles: apiRoleStorage,
    projects: apiProjectStorage,
    organizations: apiOrganizationStorage,
    dataSources: apiDataSourceStorage,
    files: apiFileStorage,
    schemaPresets: apiSchemaPresetStorage,
    sqlScriptCollections: apiSqlScriptCollectionStorage,
    sqlScriptFiles: apiSqlScriptFileStorage,
    wikiPages: apiWikiPageStorage,
    datasetFiles: apiDatasetFileStorage,
    datasetData: apiDatasetDataStorage,
    datasetRawFiles: apiDatasetRawFileStorage,
    datasetAnalyses: apiDatasetAnalysisStorage,
    pipelines: apiPipelineStorage,
    ideFiles: apiIdeFileStorage,
    etlPipelines: apiEtlPipelineStorage,
    etlFiles: apiEtlFileStorage,
    cohorts: apiCohortStorage,
    dqRuleSets: apiDqRuleSetStorage,
    dqCustomChecks: apiDqCustomCheckStorage,
    dataCatalogs: apiDataCatalogStorage,
    conceptSets: apiConceptSetStorage,
    sourceConceptIdRanges: apiSourceConceptIdRangeStorage,
    sourceConceptIdEntries: apiSourceConceptIdEntryStorage,
    mappingProjects: apiMappingProjectStorage,
    conceptMappings: apiConceptMappingStorage,
    serviceMappings: apiServiceMappingStorage,
    userPlugins: apiUserPluginStorage,
    connections: apiIdeConnectionStorage,
  }
}
