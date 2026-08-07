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
 * script that reads one database and writes another. When the PIPELINE has a
 * managed (server-owned, writable) target, go through the ETL endpoint, which
 * attaches that target writable and the other roles read-only in one
 * connection. Anything else keeps the plain read-only query path.
 *
 * `dataSourceId` is only where an unqualified statement is aimed — the picker
 * next to Run. It deliberately does not decide the endpoint: a script pointed
 * at the source still needs `target.` to resolve.
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
  const targetId = pipeline?.targetDataSourceId
  const target = dataSources.find((ds) => ds.id === targetId)
  if (!targetId || !isManaged(target)) {
    return duckdbEngine.queryDataSource(dataSourceId, sql)
  }

  // The endpoint runs against the target; every other role is attached beside
  // it, including the picked database when that is not the target itself.
  const roles: Record<string, string> = {}
  if (pipeline?.sourceDataSourceId && pipeline.sourceDataSourceId !== targetId) {
    roles.source = pipeline.sourceDataSourceId
  }
  const vocabId = vocabDataSourceId(pipeline)
  if (vocabId && vocabId !== targetId) roles.vocab = vocabId

  return runEtlOnServer(targetId, sql, roles)
}

/** ATHENA reference of the pipeline's mapping project, if any. */
function vocabDataSourceId(pipeline: EtlPipeline | undefined): string | undefined {
  if (!pipeline?.mappingProjectId) return undefined
  const { mappingProjects } = useConceptMappingStore.getState()
  return mappingProjects.find((p) => p.id === pipeline.mappingProjectId)?.vocabularyDataSourceId
}
