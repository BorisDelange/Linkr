import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Loader2, Play, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { CopySelectButton } from '@/components/ui/copy-select-button'
import { TypeBadge } from '@/components/ui/type-badge'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { OutputTable } from '@/features/projects/files/OutputTable'
import { queryAppDatabase, fetchAppDatabaseSchema } from '@/lib/api/database'
import type { IntrospectedTable } from '@/lib/api/data-sources'
import { cn } from '@/lib/utils'

interface AppDatabaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Admin tool: run read-only SQL against the app's own database and browse its
 * schema. Server mode only (the caller hides the trigger in local mode).
 */
export function AppDatabaseDialog({ open, onOpenChange }: AppDatabaseDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] max-w-[92vw] flex-col gap-0 p-0 sm:max-w-[92vw]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">{t('settings.general_db_query')}</DialogTitle>
        <Tabs defaultValue="sql" className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="flex items-center justify-center border-b px-4 py-2">
            <TabsList>
              <TabsTrigger value="sql">{t('settings.db_tab_sql')}</TabsTrigger>
              <TabsTrigger value="schema">{t('settings.db_tab_schema')}</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="sql" className="min-h-0 flex-1 data-[state=inactive]:hidden">
            <SqlTab active={open} />
          </TabsContent>
          <TabsContent value="schema" className="min-h-0 flex-1 data-[state=inactive]:hidden">
            <SchemaTab active={open} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function SqlTab({ active }: { active: boolean }) {
  const { t } = useTranslation()
  const [sql, setSql] = useState('SELECT * FROM users LIMIT 100')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [ran, setRan] = useState(false)

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    try {
      const result = await queryAppDatabase(sql)
      const cols = result.length > 0 ? Object.keys(result[0]) : []
      setHeaders(cols)
      setRows(result.map((r) => cols.map((c) => String(r[c] ?? ''))))
      setRan(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setHeaders([])
      setRows([])
      setRan(true)
    } finally {
      setRunning(false)
    }
  }, [sql])

  if (!active) return null

  return (
    <Allotment>
      <Allotment.Pane minSize={240}>
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
            <span className="text-xs text-muted-foreground">{t('settings.db_run_hint')}</span>
            <Button
              size="sm-tight"
              onClick={run}
              disabled={running || !sql.trim()}
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {t('settings.db_run')}
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <CodeEditor value={sql} language="sql" onChange={(v) => setSql(v ?? '')} onRunFile={run} />
          </div>
        </div>
      </Allotment.Pane>
      <Allotment.Pane minSize={280}>
        <div className="h-full overflow-auto p-2">
          {error ? (
            <p className="p-3 text-sm text-destructive">{error}</p>
          ) : !ran ? (
            <p className="p-3 text-sm text-muted-foreground">{t('settings.db_run_hint')}</p>
          ) : headers.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t('settings.db_no_rows')}</p>
          ) : (
            <OutputTable headers={headers} rows={rows} />
          )}
        </div>
      </Allotment.Pane>
    </Allotment>
  )
}

function SchemaTab({ active }: { active: boolean }) {
  const { t } = useTranslation()
  const [tables, setTables] = useState<IntrospectedTable[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const loadedRef = useRef(false)

  useEffect(() => {
    if (!active || loadedRef.current) return
    loadedRef.current = true
    fetchAppDatabaseSchema()
      .then((res) => {
        setTables(res)
        if (res.length > 0) setSelected(res[0].name)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [active])

  const current = tables?.find((tb) => tb.name === selected)

  const buildSelectSql = useCallback(() => {
    if (!current) return null
    const cols = current.columns.map((c) => `  "${c.name}"`).join(',\n')
    return `SELECT\n${cols}\nFROM "${current.name}"\nLIMIT 100;`
  }, [current])

  if (error) return <p className="p-4 text-sm text-destructive">{error}</p>
  if (tables === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={18} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  const filtered = tables
    .filter((tb) => !search || tb.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <Allotment proportionalLayout={false}>
      <Allotment.Pane preferredSize={220} minSize={140} maxSize={360}>
        <div className="flex h-full flex-col border-r">
          <div className="flex items-center border-b px-3 py-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('etl.profiling_tables')} ({tables.length})
            </span>
          </div>
          <div className="border-b px-2 py-1.5">
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('etl.profiling_filter_tables')}
                className="h-7 w-full rounded-md border bg-transparent pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
          <ScrollArea className="h-full flex-1">
            <div className="py-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-4 text-center text-[10px] text-muted-foreground">
                  {search ? t('etl.profiling_no_match') : t('settings.db_no_tables')}
                </p>
              ) : (
                filtered.map((tb) => (
                  <button
                    key={tb.name}
                    onClick={() => setSelected(tb.name)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                      tb.name === selected
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground hover:bg-accent/50',
                    )}
                  >
                    <span className="truncate font-mono">{tb.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {tb.columns.length}
                    </span>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      </Allotment.Pane>
      <Allotment.Pane minSize={300}>
        <div className="flex h-full flex-col">
          {current ? (
            <>
              <div className="flex items-center justify-between border-b px-3 py-1.5">
                <span className="font-mono text-xs">{current.name}</span>
                <CopySelectButton getSql={buildSelectSql} />
              </div>
              <ScrollArea className="h-full flex-1">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-muted shadow-[0_1px_0_0_var(--color-border)]">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">{t('settings.db_col_name')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('settings.db_col_type')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('settings.db_col_nullable')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.columns.map((c) => (
                      <tr key={c.name} className="border-b transition-colors last:border-0 hover:bg-accent/50">
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <TypeBadge type={c.type} />
                            <span className="font-mono">{c.name}</span>
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">{c.type}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {c.nullable ? t('settings.db_yes') : t('settings.db_no')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>
            </>
          ) : (
            <p className="p-3 text-sm text-muted-foreground">{t('settings.db_no_tables')}</p>
          )}
        </div>
      </Allotment.Pane>
    </Allotment>
  )
}
