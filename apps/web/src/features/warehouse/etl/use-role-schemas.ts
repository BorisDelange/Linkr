import { useCallback } from 'react'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { schemaName } from '@/lib/duckdb/engine'
import { isServerMode } from '@/lib/api-client'
import type { RoleSchemas } from '@/lib/duckdb/role-prefix'
import type { EtlPipeline } from '@/types'

/**
 * Map a pipeline's three database roles to their DuckDB schemas, so scripts can
 * say `source.` / `target.` / `vocab.` instead of hard-coding `ds_<uuid>` — which
 * is what made the generated 00_vocabulary.sql break on export/reimport.
 *
 * `vocab` resolves through the mapping project picked in the Vocabulary tab
 * (pipeline.mappingProjectId -> project.vocabularyDataSourceId) — one place to
 * choose it, rather than a second dropdown that could disagree.
 */
export function useRoleSchemas(pipeline: EtlPipeline | undefined) {
  const mappingProjects = useConceptMappingStore((s) => s.mappingProjects)
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const vocabDataSourceId = pipeline?.mappingProjectId
    ? mappingProjects.find((p) => p.id === pipeline.mappingProjectId)?.vocabularyDataSourceId
    : undefined

  const dataSourceIdOf = useCallback(
    (role: keyof RoleSchemas): string | undefined => {
      if (role === 'source') return pipeline?.sourceDataSourceId
      if (role === 'target') return pipeline?.targetDataSourceId
      return vocabDataSourceId
    },
    [pipeline?.sourceDataSourceId, pipeline?.targetDataSourceId, vocabDataSourceId],
  )

  /** Role of a database, or undefined for one the pipeline gives no role to. */
  const roleOf = useCallback(
    (dsId: string | undefined): keyof RoleSchemas | undefined => {
      if (!dsId) return undefined
      if (dsId === pipeline?.sourceDataSourceId) return 'source'
      if (dsId === pipeline?.targetDataSourceId) return 'target'
      if (dsId === vocabDataSourceId) return 'vocab'
      return undefined
    },
    [pipeline?.sourceDataSourceId, pipeline?.targetDataSourceId, vocabDataSourceId],
  )

  /**
   * Schemas to resolve the role prefixes against, for a run on `runningOnId`.
   *
   * Front-only: every source is a `ds_<alias>` schema of one shared DuckDB, so
   * each role maps to its own schema and cross-database SQL just works.
   *
   * Server: the query is sent to ONE data source, which the backend ATTACHes
   * under a fixed alias with a matching search_path — `ds_<alias>` exists
   * nowhere. The role of that database therefore resolves to no schema at all
   * (bare table names hit it), and the other roles stay unresolved so the error
   * names the role instead of a schema that cannot exist.
   */
  const roleSchemasFor = useCallback(
    (runningOnId: string | undefined): RoleSchemas => {
      // A role whose data source was deleted resolves to undefined, so the
      // prefix stays in the SQL and the error names the role, not a stale schema.
      const known = (id: string | undefined) =>
        id && dataSources.some((ds) => ds.id === id) ? schemaName(id) : undefined
      const managed = (id: string | undefined) =>
        !!dataSources.find((ds) => ds.id === id && (ds.connectionConfig as { managed?: boolean })?.managed)
      const forRole = (role: string, id: string | undefined) => {
        if (!id) return undefined
        if (!isServerMode()) return known(id)
        // Server, managed target: the ETL endpoint ATTACHes every role under its
        // own name, so the role IS the schema and cross-database SQL works.
        if (managed(runningOnId)) return role
        // Otherwise the query goes to a single read-only source: only the
        // database being queried is reachable, and unqualified.
        return id === runningOnId ? '' : undefined
      }
      return {
        source: forRole('source', pipeline?.sourceDataSourceId),
        target: forRole('target', pipeline?.targetDataSourceId),
        vocab: forRole('vocab', vocabDataSourceId),
      }
    },
    [dataSources, pipeline?.sourceDataSourceId, pipeline?.targetDataSourceId, vocabDataSourceId],
  )

  return { roleSchemasFor, roleOf, dataSourceIdOf, vocabDataSourceId }
}
