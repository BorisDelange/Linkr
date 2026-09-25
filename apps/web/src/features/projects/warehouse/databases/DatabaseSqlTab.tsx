import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Keyboard, Loader2, Play } from 'lucide-react'
import type * as Monaco from 'monaco-editor'
import { Button } from '@/components/ui/button'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { KeyboardShortcutsDialog } from '@/features/projects/files/KeyboardShortcutsDialog'
import type { ShortcutActionId } from '@/types/shortcuts'
import { queryDataSource } from '@/lib/duckdb/engine'
import { formatApiError } from '@/lib/api-client'

/** Rows shown; the query itself is capped server-side too. */
const SHOWN_ROWS = 1000

const SHORTCUT_ACTIONS: ShortcutActionId[] = ['run_selection_or_line', 'run_file']

interface ResultRow {
  index: number
  cells: string[]
}

type Outcome =
  | { kind: 'rows'; headers: string[]; rows: ResultRow[]; total: number; ms: number }
  | { kind: 'error'; message: string; ms: number }

/** The draft of each database's query, kept while the app is open — this tab
 *  saves nothing, but leaving it for the Schema tab must not lose the query. */
const drafts = new Map<string, string>()

/** A scratch SQL console on one database: write, run, read the result. No
 *  scripts, no files, no saving — the SQL scripts page is for that. */
export function DatabaseSqlTab({ dataSourceId }: { dataSourceId: string }) {
  const { t } = useTranslation()
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  // Controlled: CodeEditor feeds Monaco this value back once its debounced
  // onChange lands, so a value that never follows the typing erases it.
  const [sql, setSql] = useState(() => drafts.get(dataSourceId) ?? '')
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

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
    if (!sql) return
    setRunning(true)
    const start = performance.now()
    try {
      const rows = await queryDataSource(dataSourceId, sql)
      const headers = rows.length > 0 ? Object.keys(rows[0]) : []
      setOutcome({
        kind: 'rows',
        headers,
        rows: rows.slice(0, SHOWN_ROWS).map((row, index) => ({
          index,
          cells: headers.map((h) => (row[h] == null ? '' : String(row[h]))),
        })),
        total: rows.length,
        ms: Math.round(performance.now() - start),
      })
    } catch (err) {
      const f = formatApiError(err)
      setOutcome({
        kind: 'error',
        message: f.summaryKey ? t(f.summaryKey, { count: f.summaryCount ?? 0 }) : (f.summary ?? String(err)),
        ms: Math.round(performance.now() - start),
      })
    } finally {
      setRunning(false)
    }
  }

  const resultColumns = useMemo<ConceptColumn<ResultRow>[]>(
    () => (outcome?.kind === 'rows' ? outcome.headers : []).map((h, i) => ({
      id: `c${i}`,
      header: h,
      accessor: (r) => r.cells[i],
      filter: 'text',
      size: 160,
    })),
    [outcome],
  )

  return (
    <TooltipProvider>
    <div className="flex h-full min-h-0 flex-col px-6 pb-4">
      <div className="flex shrink-0 items-center gap-3 pb-2">
        <div className="flex-1" />
        {outcome && (
          <span className={outcome.kind === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
            {outcome.kind === 'error'
              ? t('databases.sql_failed', { ms: outcome.ms })
              : t('databases.sql_rows', { count: outcome.total, ms: outcome.ms })}
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={() => setShortcutsOpen(true)} aria-label={t('files.shortcuts')}>
              <Keyboard size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('files.shortcuts')}</TooltipContent>
        </Tooltip>
        <Button size="sm" onClick={() => void run('all')} disabled={running}>
          {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {t('databases.sql_run')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
        <Allotment vertical>
          <Allotment.Pane preferredSize="40%" minSize={80}>
            <CodeEditor
              value={sql}
              language="sql"
              editorRef={editorRef}
              onChange={(v) => {
                setSql(v ?? '')
                drafts.set(dataSourceId, v ?? '')
              }}
              onRunSelectionOrLine={() => void run('line')}
              onRunFile={() => void run('all')}
            />
          </Allotment.Pane>
          <Allotment.Pane minSize={80}>
            <div className="h-full overflow-hidden border-t">
              {!outcome ? (
                <p className="p-4 text-xs text-muted-foreground">{t('databases.sql_empty')}</p>
              ) : outcome.kind === 'error' ? (
                <pre className="whitespace-pre-wrap p-4 font-mono text-xs text-destructive">{outcome.message}</pre>
              ) : outcome.headers.length === 0 ? (
                <p className="p-4 text-xs text-muted-foreground">{t('databases.sql_no_rows')}</p>
              ) : (
                <ConceptDataTable
                  key={outcome.headers.join('\u0000')}
                  data={outcome.rows}
                  columns={resultColumns}
                  rowKey={(r) => r.index}
                  pageSize={100}
                  reorderable
                  cellTooltips="all"
                />
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
