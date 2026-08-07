import { useCallback, useEffect } from 'react'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { schemaName } from '@/lib/duckdb/engine'
import { isServerMode } from '@/lib/api-client'
import type { RoleSchemas } from '@/lib/duckdb/role-prefix'
import type { EtlPipeline } from '@/types'

export interface RoleSchemaInput {
  serverMode: boolean
  /** Database an unqualified statement is aimed at (the picker next to Run). */
  runningOnId: string | undefined
  sourceId: string | undefined
  targetId: string | undefined
  vocabId: string | undefined
  /** Ids that still exist; a role pointing elsewhere stays unresolved. */
  knownIds: string[]
  /** Whether the pipeline's target is a server-owned writable database. */
  targetIsManaged: boolean
}

/**
 * Decide what `source.` / `target.` / `vocab.` resolve to. Pure, so the rule
 * can be tested without a store: the roles come from the pipeline and the
 * Vocabulary tab, never from `runningOnId`.
 */
export function computeRoleSchemas(input: RoleSchemaInput): RoleSchemas {
  const { serverMode, runningOnId, knownIds, targetIsManaged } = input
  // A role whose data source was deleted resolves to undefined, so the prefix
  // stays in the SQL and the error names the role, not a stale schema.
  const known = (id: string | undefined) =>
    id && knownIds.includes(id) ? schemaName(id) : undefined
  const forRole = (role: string, id: string | undefined) => {
    if (!id) return undefined
    if (!serverMode) return known(id)
    // The ETL endpoint attaches every role under its own name, so the role IS
    // the schema — whichever database the picker happens to point at.
    if (targetIsManaged) return role
    // Otherwise one read-only database is reachable, and only unqualified.
    return id === runningOnId ? '' : undefined
  }
  return {
    source: forRole('source', input.sourceId),
    target: forRole('target', input.targetId),
    vocab: forRole('vocab', input.vocabId),
  }
}

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
  const mappingProjectsLoaded = useConceptMappingStore((s) => s.mappingProjectsLoaded)
  const loadMappingProjects = useConceptMappingStore((s) => s.loadMappingProjects)
  const dataSources = useDataSourceStore((s) => s.dataSources)

  // `vocab` resolves through the mapping project, so the projects must be there
  // even when the user never opened the Vocabulary or Pipeline tab — otherwise
  // `vocab.` silently stays unresolved in a script run from the Scripts tab.
  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
  }, [mappingProjectsLoaded, loadMappingProjects])

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
   * The roles themselves always come from the pipeline (its source/target) and
   * the Vocabulary tab. `runningOnId` only says which database an unqualified
   * statement is aimed at — the picker next to Run is a navigation aid, so it
   * must not change what `target.` means.
   *
   * Front-only: every source is a `ds_<alias>` schema of one shared DuckDB, so
   * each role maps to its own schema and cross-database SQL just works.
   *
   * Server: a run whose pipeline has a managed (writable) target goes through
   * the ETL endpoint, which ATTACHes every role under its own name — the role
   * IS the schema. Without such a target the query is sent to ONE read-only
   * source that the backend ATTACHes under a fixed alias, so only that database
   * is reachable, unqualified; the other roles stay unresolved and the error
   * names the role instead of a schema that cannot exist.
   */
  const roleSchemasFor = useCallback(
    (runningOnId: string | undefined): RoleSchemas => (
      computeRoleSchemas({
        serverMode: isServerMode(),
        runningOnId,
        sourceId: pipeline?.sourceDataSourceId,
        targetId: pipeline?.targetDataSourceId,
        vocabId: vocabDataSourceId,
        knownIds: dataSources.map((ds) => ds.id),
        targetIsManaged: !!dataSources.find(
          (ds) => ds.id === pipeline?.targetDataSourceId
            && (ds.connectionConfig as { managed?: boolean })?.managed,
        ),
      })
    ),
    [dataSources, pipeline?.sourceDataSourceId, pipeline?.targetDataSourceId, vocabDataSourceId],
  )

  return { roleSchemasFor, roleOf, dataSourceIdOf, vocabDataSourceId }
}
