import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Loader2, Play } from 'lucide-react'
import type * as Monaco from 'monaco-editor'
import { Button } from '@/components/ui/button'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { OutputTable } from '@/features/projects/files/OutputTable'
import { queryDataSource } from '@/lib/duckdb/engine'
import { formatApiError } from '@/lib/api-client'

/** Rows shown; the query itself is capped server-side too. */
const SHOWN_ROWS = 1000

type Outcome =
  | { kind: 'rows'; headers: string[]; rows: string[][]; total: number; ms: number }
  | { kind: 'error'; message: string; ms: number }

/** The draft of each database's query, kept while the app is open — this tab
 *  saves nothing, but leaving it for the Schema tab must not lose the query. */
const drafts = new Map<string, string>()

/** A scratch SQL console on one database: write, run, read the result. No
 *  scripts, no files, no saving — the SQL scripts page is for that. */
export function DatabaseSqlTab({ dataSourceId }: { dataSourceId: string }) {
  const { t } = useTranslation()
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const run = async () => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || running) return
    const selection = editor.getSelection()
    const selected = selection && !selection.isEmpty() ? model.getValueInRange(selection) : ''
    const sql = (selected || model.getValue()).trim()
    if (!sql) return
    setRunning(true)
    const start = performance.now()
    try {
      const rows = await queryDataSource(dataSourceId, sql)
      const headers = rows.length > 0 ? Object.keys(rows[0]) : []
      setOutcome({
        kind: 'rows',
        headers,
        rows: rows.slice(0, SHOWN_ROWS).map((row) => headers.map((h) => (row[h] == null ? '' : String(row[h])))),
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

  return (
    <div className="flex h-full min-h-0 flex-col px-6 pb-4">
      <div className="flex shrink-0 items-center gap-3 pb-2">
        <Button size="sm" onClick={() => void run()} disabled={running}>
          {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {t('databases.sql_run')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('databases.sql_hint')}</span>
        <div className="flex-1" />
        {outcome && (
          <span className={outcome.kind === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
            {outcome.kind === 'error'
              ? t('databases.sql_failed', { ms: outcome.ms })
              : t('databases.sql_rows', { count: outcome.total, ms: outcome.ms })}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
        <Allotment vertical>
          <Allotment.Pane preferredSize="40%" minSize={80}>
            <CodeEditor
              value={drafts.get(dataSourceId) ?? ''}
              language="sql"
              editorRef={editorRef}
              onChange={(v) => drafts.set(dataSourceId, v ?? '')}
              onRunSelectionOrLine={() => void run()}
              onRunFile={() => void run()}
            />
          </Allotment.Pane>
          <Allotment.Pane minSize={80}>
            <div className="h-full overflow-auto border-t">
              {!outcome ? (
                <p className="p-4 text-xs text-muted-foreground">{t('databases.sql_empty')}</p>
              ) : outcome.kind === 'error' ? (
                <pre className="whitespace-pre-wrap p-4 font-mono text-xs text-destructive">{outcome.message}</pre>
              ) : outcome.headers.length === 0 ? (
                <p className="p-4 text-xs text-muted-foreground">{t('databases.sql_no_rows')}</p>
              ) : (
                <OutputTable headers={outcome.headers} rows={outcome.rows} />
              )}
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}
