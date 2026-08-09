import { useCallback } from 'react'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { resolveRolePrefixes, usedRoles } from '@/lib/duckdb/role-prefix'
import { RunAbortedError, runPipelineSql } from './run-pipeline-sql'
import { mappingExportNameOf } from '@/lib/duckdb/mapping-source'
import { treeNodePath } from '@/lib/entity-tree'
import { useRoleSchemas } from './use-role-schemas'
import type { EtlFile, EtlPipeline } from '@/types'

interface RunnerOptions {
  /** Called when a script fails, so a tab can reveal it (select the node, open
   *  the sidebar). The run always stops at the first failure either way. */
  onScriptError?: (fileId: string) => void
}

/**
 * Run a pipeline's scripts, reporting progress through the ETL store.
 *
 * Shared by the Pipeline and Scripts tabs: the Scripts tab used to run its own
 * silent loop over a local boolean, so a Run-all there showed a spinner and
 * nothing else while the Pipeline tab next door tracked every script. One runner
 * means one behaviour — per-script status, run history, and a Stop that works.
 */
export function usePipelineRunner(pipeline: EtlPipeline | undefined, options: RunnerOptions = {}) {
  const { onScriptError } = options
  const pipelineRunning = useEtlStore((s) => s.pipelineRunning)
  const { roleSchemasFor, dataSourceIdOf } = useRoleSchemas(pipeline)

  /**
   * CSV text of the `mapping.` exports this pipeline holds, keyed by export name.
   *
   * Read at run time rather than captured: the Vocabulary tab rewrites the file
   * whenever it regenerates the script, and a run must use the current rows.
   */
  const mappingDataFor = useCallback((): Record<string, string> => {
    if (!pipeline) return {}
    const own = useEtlStore.getState().files.filter((f) => f.pipelineId === pipeline.id)
    const byId = new Map(own.map((f) => [f.id, f]))
    const data: Record<string, string> = {}
    for (const f of own) {
      if (f.type !== 'file' || !f.content) continue
      const name = mappingExportNameOf(treeNodePath(f, byId))
      if (name) data[name] = f.content
    }
    return data
  }, [pipeline])

  /**
   * `files` is the ordered list to execute. Disabled ones are marked skipped
   * rather than dropped, so the run history shows they were deliberately left out.
   */
  const runScripts = useCallback(async (files: EtlFile[]) => {
    if (!pipeline || files.length === 0) return
    const store = useEtlStore.getState()
    // A run is already in flight (possibly started from another tab): don't start
    // a second one that would orphan the first's AbortController.
    if (!store.startPipelineRun()) return
    const abort = useEtlStore.getState().pipelineRunAbort
    const { testConnection } = useDataSourceStore.getState()
    const pipelineId = pipeline.id

    const log = (fileId: string, patch: Partial<import('@/types').EtlRunLog>) => {
      useEtlStore.getState().setScriptStatus(fileId, {
        id: `log-${fileId}-${Date.now()}`,
        pipelineId,
        fileId,
        status: 'running',
        ...patch,
      })
    }

    if (pipeline.sourceDataSourceId) await testConnection(pipeline.sourceDataSourceId)
    if (pipeline.targetDataSourceId) await testConnection(pipeline.targetDataSourceId)

    let hasError = false
    for (const file of files) {
      if (abort?.signal.aborted) break

      if (file.disabled || !file.content) {
        log(file.id, { status: 'skipped' })
        continue
      }

      const dsId = file.dataSourceId ?? pipeline.targetDataSourceId ?? pipeline.sourceDataSourceId
      if (!dsId) {
        log(file.id, { status: 'skipped' })
        continue
      }

      log(file.id, { status: 'running', startedAt: new Date().toISOString() })

      const start = Date.now()
      try {
        await testConnection(dsId)
        // Mount whichever role the script reaches for, then resolve the
        // `source.`/`target.` qualifiers (see lib/duckdb/role-prefix).
        for (const role of usedRoles(file.content)) {
          const roleId = dataSourceIdOf(role)
          if (roleId && roleId !== dsId) await testConnection(roleId)
        }
        const resolvedSql = resolveRolePrefixes(file.content, roleSchemasFor(dsId))
        const rows = await runPipelineSql(pipeline, dsId, resolvedSql, {
          mappingData: mappingDataFor(),
          signal: abort?.signal,
          onProgress: (done, total, next) => {
            log(file.id, {
              status: 'running',
              startedAt: new Date(start).toISOString(),
              statementsDone: done,
              statementsTotal: total,
              currentStatement: next,
            })
          },
        })
        const durationMs = Date.now() - start
        log(file.id, {
          status: 'success',
          startedAt: new Date(start).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs,
          rowsAffected: rows.length,
          output: `${rows.length} row${rows.length !== 1 ? 's' : ''} in ${durationMs}ms`,
        })
      } catch (err) {
        // A stop is not a failure: stopPipelineRun already relabels the script
        // in flight as "stopped", so leave that status alone and just end the run.
        if (err instanceof RunAbortedError) break
        hasError = true
        log(file.id, {
          status: 'error',
          startedAt: new Date(start).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        })
        onScriptError?.(file.id)
        break
      }
    }

    useEtlStore.getState().finishPipelineRun(
      hasError || abort?.signal.aborted ? 'error' : 'success',
    )
  }, [pipeline, roleSchemasFor, dataSourceIdOf, mappingDataFor, onScriptError])

  /**
   * Run one ad-hoc chunk of SQL (a file, a selection, a line) through the same
   * store state as a full run, so the toolbar can stop it and the button does not
   * revert to "Run" when the tab is unmounted and remounted.
   *
   * `fileId` scopes the status to the script it came from; a selection reports
   * against its own file.
   */
  const runOne = useCallback(async (
    fileId: string,
    sql: string,
    dataSourceId: string,
  ): Promise<Record<string, unknown>[]> => {
    if (!pipeline) return []
    const store = useEtlStore.getState()
    if (!store.startPipelineRun()) return []
    const abort = useEtlStore.getState().pipelineRunAbort
    const pipelineId = pipeline.id
    const start = Date.now()

    const log = (patch: Partial<import('@/types').EtlRunLog>) => {
      useEtlStore.getState().setScriptStatus(fileId, {
        id: `log-${fileId}-${Date.now()}`,
        pipelineId,
        fileId,
        status: 'running',
        startedAt: new Date(start).toISOString(),
        ...patch,
      })
    }

    log({ status: 'running' })
    try {
      const { testConnection } = useDataSourceStore.getState()
      await testConnection(dataSourceId)
      for (const role of usedRoles(sql)) {
        const roleId = dataSourceIdOf(role)
        if (roleId && roleId !== dataSourceId) await testConnection(roleId)
      }
      const resolved = resolveRolePrefixes(sql, roleSchemasFor(dataSourceId))
      const rows = await runPipelineSql(pipeline, dataSourceId, resolved, {
        mappingData: mappingDataFor(),
        signal: abort?.signal,
        onProgress: (done, total, next) => log({
          statementsDone: done, statementsTotal: total, currentStatement: next,
        }),
      })
      const durationMs = Date.now() - start
      log({
        status: 'success',
        completedAt: new Date().toISOString(),
        durationMs,
        rowsAffected: rows.length,
        output: `${rows.length} row${rows.length !== 1 ? 's' : ''} in ${durationMs}ms`,
      })
      useEtlStore.getState().finishPipelineRun('success')
      return rows
    } catch (err) {
      // A stop leaves the "stopped" status stopPipelineRun already set, but still
      // propagates: the caller must not treat the partial rows as a result.
      if (err instanceof RunAbortedError) throw err
      log({
        status: 'error',
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      })
      useEtlStore.getState().finishPipelineRun('error')
      throw err
    }
  }, [pipeline, roleSchemasFor, dataSourceIdOf, mappingDataFor])

  const stop = useCallback(() => useEtlStore.getState().stopPipelineRun(), [])

  return { runScripts, runOne, stop, running: pipelineRunning }
}
