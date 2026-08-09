import { useCallback } from 'react'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { resolveRolePrefixes, usedRoles } from '@/lib/duckdb/role-prefix'
import { runPipelineSql } from './run-pipeline-sql'
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
   * `files` is the ordered list to execute. Disabled ones are marked skipped
   * rather than dropped, so the run history shows they were deliberately left out.
   */
  const runScripts = useCallback(async (files: EtlFile[]) => {
    if (!pipeline || files.length === 0) return
    const store = useEtlStore.getState()
    store.startPipelineRun()
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
          signal: abort?.signal,
          onProgress: (done, total) => {
            log(file.id, {
              status: 'running',
              startedAt: new Date(start).toISOString(),
              statementsDone: done,
              statementsTotal: total,
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
  }, [pipeline, roleSchemasFor, dataSourceIdOf, onScriptError])

  const stop = useCallback(() => useEtlStore.getState().stopPipelineRun(), [])

  return { runScripts, stop, running: pipelineRunning }
}
