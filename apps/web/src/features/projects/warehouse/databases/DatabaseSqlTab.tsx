import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Cpu, Database, Keyboard, Loader2, Lock, Play, Square } from 'lucide-react'
import type * as Monaco from 'monaco-editor'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { OutputTable } from '@/features/projects/files/OutputTable'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { KeyboardShortcutsDialog } from '@/features/projects/files/KeyboardShortcutsDialog'
import type { ShortcutActionId } from '@/types/shortcuts'
import { queryDataSource } from '@/lib/duckdb/engine'
import { formatApiError, isServerMode } from '@/lib/api-client'
import type { QueryExecution } from '@/lib/api/data-sources'
import { computesQueries, ENGINE_LABELS } from '@/lib/database-engines'
import { formatDateTimeLocale, formatDuration, formatSqlCell } from '@/lib/format-helpers'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { DatabaseConnectionConfig } from '@/types'
import { sqlConsoleDrafts as drafts, takePendingRun } from './sql-console-drafts'

/** Rows shown; the query itself is capped server-side too. */
const SHOWN_ROWS = 1000

const SHORTCUT_ACTIONS: ShortcutActionId[] = ['run_selection_or_line', 'run_file']

/** A query answered sooner says nothing while it runs: no flash of a loader. */
const RUNNING_NOTICE_DELAY_MS = 400

/** `at`: when the query was sent (ISO). */
type Outcome =
  | { kind: 'rows'; headers: string[]; rows: string[][]; total: number; ms: number; at: string; execution: QueryExecution | null }
  | { kind: 'error'; message: string; ms: number; at: string; execution: QueryExecution | null }
  | { kind: 'stopped'; ms: number; at: string; execution: null }

interface Props {
  dataSourceId: string
  /** Whose draft this console keeps; defaults to the database's own. */
  draftKey?: string
  /** Replaces the draft on mount — remount (a new `key`) to load another query. */
  initialSql?: string
  /** Runs `initialSql` as soon as the console mounts. */
  runOnMount?: boolean
}

/** A scratch SQL console on one database: write, run, read the result. No
 *  scripts, no files, no saving — the SQL scripts page is for that. */
export function DatabaseSqlTab({ dataSourceId, draftKey = dataSourceId, initialSql, runOnMount = false }: Props) {
  const { t, i18n } = useTranslation()
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  // Controlled: CodeEditor feeds Monaco this value back once its debounced
  // onChange lands, so a value that never follows the typing erases it.
  const [sql, setSql] = useState(() => {
    if (initialSql !== undefined) drafts.set(draftKey, initialSql)
    return drafts.get(draftKey) ?? ''
  })
  const engine = useDataSourceStore((s) => (s.dataSources.find((d) => d.id === dataSourceId)?.connectionConfig as DatabaseConnectionConfig | undefined)?.engine)
  const offersNative = isServerMode() && computesQueries(engine)
  const [native, setNative] = useState(false)
  const [running, setRunning] = useState(false)
  // Between the click on Stop and the query actually ending (a deferred query is
  // polled every 1.5 s): the click must show it was taken into account.
  const [stopping, setStopping] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  // Leaving the console stops its query: its result would have nowhere to go.
  useEffect(() => () => controllerRef.current?.abort(), [])

  const execute = useCallback(async (sql: string) => {
    const controller = new AbortController()
    controllerRef.current = controller
    // The previous result goes at once: left in place, it would read as this query's.
    setOutcome(null)
    setRunning(true)
    const at = new Date().toISOString()
    const start = performance.now()
    let execution: QueryExecution | null = null
    const onExecution = (e: QueryExecution) => { execution = e }
    try {
      const rows = await queryDataSource(dataSourceId, sql, { native: offersNative && native, onExecution, signal: controller.signal })
      const headers = rows.length > 0 ? Object.keys(rows[0]) : []
      setOutcome({
        kind: 'rows',
        headers,
        rows: rows.slice(0, SHOWN_ROWS).map((row) => headers.map((h) => formatSqlCell(row[h]))),
        total: rows.length,
        ms: performance.now() - start,
        at,
        execution,
      })
    } catch (err) {
      if (controller.signal.aborted) {
        setOutcome({ kind: 'stopped', ms: performance.now() - start, at, execution: null })
        return
      }
      const f = formatApiError(err)
      setOutcome({
        kind: 'error',
        message: f.summaryKey ? t(f.summaryKey, { count: f.summaryCount ?? 0 }) : (f.summary ?? String(err)),
        ms: performance.now() - start,
        at,
        execution,
      })
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      setRunning(false)
      setStopping(false)
    }
  }, [dataSourceId, t, offersNative, native])

  /** `line`: the selection, else the line under the cursor. `all`: the whole editor. */
  const run = async (scope: 'line' | 'all') => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || running) return
    let sql = model.getValue()
    if (scope === 'line') {
      const selection = editor.getSelection()
      sql = selection && !selection.isEmpty()
        ? model.getValueInRange(selection)
        : model.getLineContent(editor.getPosition()?.lineNumber ?? 1)
    }
    sql = sql.trim()
    if (sql) await execute(sql)
  }

  useEffect(() => {
    const sql = initialSql?.trim()
    if (runOnMount && sql) void execute(sql)
  }, [runOnMount, initialSql, execute])

  useEffect(() => {
    const sql = drafts.get(draftKey)?.trim()
    if (takePendingRun(draftKey) && sql) void execute(sql)
  }, [draftKey, execute])

  return (
    <TooltipProvider>
    <div className="flex h-full min-h-0 flex-col px-6 pb-4">
      <div className="flex shrink-0 items-center gap-2 pb-2">
        {outcome && (
          <span className={cn('text-xs leading-none', outcome.kind === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
            {outcome.kind === 'error'
              ? t('databases.sql_failed', { duration: formatDuration(outcome.ms), at: formatDateTimeLocale(outcome.at, i18n.language, { seconds: true }) })
              : outcome.kind === 'stopped'
                ? t('databases.sql_stopped', { duration: formatDuration(outcome.ms), at: formatDateTimeLocale(outcome.at, i18n.language, { seconds: true }) })
                : t('databases.sql_rows', { count: outcome.total, duration: formatDuration(outcome.ms), at: formatDateTimeLocale(outcome.at, i18n.language, { seconds: true }) })}
          </span>
        )}
        {outcome?.execution && engine && <ExecutionBadge execution={outcome.execution} engineLabel={ENGINE_LABELS[engine]} />}
        <div className="flex-1" />
        {offersNative && engine && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5">
                <Switch id={`sql-native-${draftKey}`} size="sm" checked={native} onCheckedChange={setNative} disabled={running} />
                <Label htmlFor={`sql-native-${draftKey}`} className="text-muted-foreground">
                  {t('databases.sql_native', { engine: ENGINE_LABELS[engine] })}
                </Label>
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{t('databases.sql_native_hint', { engine: ENGINE_LABELS[engine] })}</TooltipContent>
          </Tooltip>
        )}
        {/* Every engine opens the source read-only here (see db_connect / engine.ts):
            the SQL tab reads, an ETL pipeline is what writes. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <Lock size={10} />
              {t('databases.sql_read_only')}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {t(isServerMode() ? 'databases.sql_read_only_hint_server' : 'databases.sql_read_only_hint_client')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={() => setShortcutsOpen(true)} aria-label={t('files.shortcuts')}>
              <Keyboard size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('files.shortcuts')}</TooltipContent>
        </Tooltip>
        {running ? (
          <Button
            size="xs"
            variant="destructive"
            className="gap-1"
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              controllerRef.current?.abort()
            }}
          >
            {stopping ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
            {stopping ? t('databases.sql_stopping') : t('databases.sql_stop')}
          </Button>
        ) : (
          <Button size="xs" className="gap-1" onClick={() => void run('all')}>
            <Play size={12} />
            {t('databases.sql_run')}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
        <Allotment vertical>
          <Allotment.Pane preferredSize="40%" minSize={80}>
            <CodeEditor
              value={sql}
              language="sql"
              completion={{ kind: 'sql', dataSourceId }}
              editorRef={editorRef}
              onChange={(v) => {
                setSql(v ?? '')
                drafts.set(draftKey, v ?? '')
              }}
              onRunSelectionOrLine={() => void run('line')}
              onRunFile={() => void run('all')}
            />
          </Allotment.Pane>
          <Allotment.Pane minSize={80}>
            <div className="h-full overflow-hidden border-t">
              {running ? (
                <RunningNotice stopping={stopping} />
              ) : !outcome ? (
                <p className="p-4 text-xs text-muted-foreground">{t('databases.sql_empty')}</p>
              ) : outcome.kind === 'stopped' ? (
                <p className="p-4 text-xs text-muted-foreground">{t('databases.sql_stopped_hint')}</p>
              ) : outcome.kind === 'error' ? (
                <pre className="whitespace-pre-wrap p-4 font-mono text-xs text-destructive">{outcome.message}</pre>
              ) : outcome.headers.length === 0 ? (
                <p className="p-4 text-xs text-muted-foreground">{t('databases.sql_no_rows')}</p>
              ) : (
                <OutputTable key={outcome.headers.join('\u0000')} headers={outcome.headers} rows={outcome.rows} />
              )}
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} actionIds={SHORTCUT_ACTIONS} />
    </div>
    </TooltipProvider>
  )
}

/** Shown once the query has run for a moment, with its elapsed time; at once
 *  when a stop was asked for. */
function RunningNotice({ stopping }: { stopping: boolean }) {
  const { t } = useTranslation()
  const [elapsed, setElapsed] = useState<number | null>(null)
  useEffect(() => {
    const start = performance.now()
    let ticker: ReturnType<typeof setInterval> | undefined
    const shown = setTimeout(() => {
      setElapsed(performance.now() - start)
      ticker = setInterval(() => setElapsed(performance.now() - start), 100)
    }, RUNNING_NOTICE_DELAY_MS)
    return () => {
      clearTimeout(shown)
      clearInterval(ticker)
    }
  }, [])
  if (stopping) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-destructive">
        <Loader2 size={14} className="animate-spin" />
        {t('databases.sql_stopping_hint')}
      </div>
    )
  }
  if (elapsed === null) return null
  return (
    <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2 size={14} className="animate-spin" />
      {t('databases.sql_running', { duration: formatDuration(elapsed) })}
    </div>
  )
}

/** Who computed the query: the external database itself, or Linkr over the
 *  connection — slower, since every row it reads crosses the network. */
function ExecutionBadge({ execution, engineLabel }: { execution: QueryExecution; engineLabel: string }) {
  const { t } = useTranslation()
  const byDatabase = execution.computedBy === 'database'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          {byDatabase ? <Database size={10} /> : <Cpu size={10} />}
          {byDatabase ? t('databases.sql_computed_by_database', { engine: engineLabel }) : t('databases.sql_computed_by_linkr')}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        {byDatabase ? (
          t('databases.sql_computed_by_database_hint', { engine: engineLabel })
        ) : (
          <div className="space-y-1">
            <p>{t('databases.sql_computed_by_linkr_hint', { engine: engineLabel })}</p>
            {execution.reason && <p className="font-mono">{t('databases.sql_computed_by_linkr_reason', { reason: execution.reason })}</p>}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
