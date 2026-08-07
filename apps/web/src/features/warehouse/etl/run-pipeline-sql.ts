import { isServerMode } from '@/lib/api-client'
import { runEtlOnServer } from '@/lib/api/data-sources'
import * as duckdbEngine from '@/lib/duckdb/engine'
import type { DatabaseConnectionConfig, DataSource, EtlPipeline } from '@/types'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'

function isManaged(ds: DataSource | undefined): boolean {
  return !!(ds && (ds.connectionConfig as DatabaseConnectionConfig)?.managed)
}

/**
 * Run one ETL statement batch.
 *
 * Front-only: every database is a schema of the same browser DuckDB, so a plain
 * query already reaches all of them.
 *
 * Server: a normal query is sent to a single data source, which cannot serve a
 * script that reads one database and writes another. When the run targets a
 * managed (server-owned, writable) database, go through the ETL endpoint, which
 * attaches the target writable and the other roles read-only in one connection.
 * Anything else keeps the plain read-only query path.
 */
export async function runPipelineSql(
  pipeline: EtlPipeline | undefined,
  dataSourceId: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  if (!isServerMode()) {
    return duckdbEngine.queryDataSource(dataSourceId, sql)
  }

  const { dataSources } = useDataSourceStore.getState()
  const target = dataSources.find((ds) => ds.id === dataSourceId)
  if (!isManaged(target)) {
    return duckdbEngine.queryDataSource(dataSourceId, sql)
  }

  const roles: Record<string, string> = {}
  if (pipeline?.sourceDataSourceId && pipeline.sourceDataSourceId !== dataSourceId) {
    roles.source = pipeline.sourceDataSourceId
  }
  const vocabId = vocabDataSourceId(pipeline)
  if (vocabId && vocabId !== dataSourceId) roles.vocab = vocabId

  return runEtlOnServer(dataSourceId, sql, roles)
}

/** ATHENA reference of the pipeline's mapping project, if any. */
function vocabDataSourceId(pipeline: EtlPipeline | undefined): string | undefined {
  if (!pipeline?.mappingProjectId) return undefined
  const { mappingProjects } = useConceptMappingStore.getState()
  return mappingProjects.find((p) => p.id === pipeline.mappingProjectId)?.vocabularyDataSourceId
}
