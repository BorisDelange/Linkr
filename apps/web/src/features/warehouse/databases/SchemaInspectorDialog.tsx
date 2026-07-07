import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Table2, Copy, Check } from 'lucide-react'
import * as duckdbEngine from '@/lib/duckdb/engine'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface ColumnInfo {
  column_name: string
  data_type: string
  is_nullable: string
}

/**
 * Browse a data source's tables + columns, with a per-table "copy SELECT".
 * Shared by the SQL scripts editor and the IDE — both pass a dataSourceId that
 * `queryDataSource` understands (warehouse source id / active connection id).
 */
export function SchemaInspectorDialog({
  open,
  onOpenChange,
  dataSourceId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  dataSourceId: string
}) {
  const { t } = useTranslation()
  const [tables, setTables] = useState<string[]>([])
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [tableSearch, setTableSearch] = useState('')

  const filteredTables = tables.filter((tbl) =>
    tbl.toLowerCase().includes(tableSearch.trim().toLowerCase()),
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    duckdbEngine.discoverTables(dataSourceId).then((result) => {
      if (cancelled) return
      setTables(result)
      setSelectedTable(result[0] ?? null)
      setLoading(false)
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, dataSourceId])

  useEffect(() => {
    if (!selectedTable || !open) {
      setColumns([])
      return
    }
    setCopied(false)
    let cancelled = false
    duckdbEngine
      .queryDataSource(
        dataSourceId,
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${selectedTable}' ORDER BY ordinal_position`,
      )
      .then((rows) => {
        if (cancelled) return
        setColumns(
          rows.map((r) => ({
            column_name: String(r.column_name),
            data_type: String(r.data_type),
            is_nullable: String(r.is_nullable),
          })),
        )
      })
      .catch(() => {
        if (!cancelled) setColumns([])
      })
    return () => { cancelled = true }
  }, [selectedTable, open, dataSourceId])

  const handleCopySelect = useCallback(() => {
    if (!selectedTable || columns.length === 0) return
    const cols = columns.map((c) => `  ${c.column_name}`).join(',\n')
    const sql = `SELECT\n${cols}\nFROM ${selectedTable}\nLIMIT 100;`
    navigator.clipboard.writeText(sql).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [selectedTable, columns])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('sql_scripts.browse_schema')}</DialogTitle>
        </DialogHeader>
        <div className="flex h-[560px] gap-0 overflow-hidden rounded-md border">
          <div className="flex w-48 shrink-0 flex-col overflow-hidden border-r bg-muted/30">
            <div className="shrink-0 border-b p-1.5">
              <Input
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
                placeholder={t('sql_scripts.search_tables')}
                className="h-7 text-xs"
              />
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading && (
                <p className="p-3 text-xs text-muted-foreground">{t('common.loading')}…</p>
              )}
              {!loading && tables.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">{t('sql_scripts.no_tables')}</p>
              )}
              {!loading && tables.length > 0 && filteredTables.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">{t('sql_scripts.no_tables')}</p>
              )}
              {filteredTables.map((table) => (
                <button
                  key={table}
                  onClick={() => setSelectedTable(table)}
                  className={cn(
                    'flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs transition-colors',
                    selectedTable === table
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  <Table2 size={12} className="shrink-0 text-blue-500" />
                  <span className="truncate">{table}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-1 flex-col overflow-hidden">
            {selectedTable && columns.length > 0 && (
              <>
                <div className="flex items-center justify-between border-b px-3 py-1.5">
                  <span className="text-xs font-medium">{selectedTable}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={handleCopySelect}
                        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                        {t('sql_scripts.copy_select')}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t('sql_scripts.copy_select_tooltip')}</TooltipContent>
                  </Tooltip>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <table className="w-full text-xs">
                    {/* Opaque (not /50) so scrolled rows don't show through. */}
                    <thead className="sticky top-0 z-10 bg-muted shadow-[0_1px_0_0_var(--color-border)]">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">{t('sql_scripts.column_name')}</th>
                        <th className="px-3 py-2 text-left font-medium">{t('sql_scripts.data_type')}</th>
                        <th className="px-3 py-2 text-left font-medium">{t('sql_scripts.nullable')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((col) => (
                        <tr key={col.column_name} className="border-b last:border-0 hover:bg-accent/30">
                          <td className="px-3 py-1.5 font-mono">{col.column_name}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{col.data_type}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{col.is_nullable === 'YES' ? '✓' : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {selectedTable && columns.length === 0 && !loading && (
              <p className="p-4 text-xs text-muted-foreground">{t('sql_scripts.no_columns')}</p>
            )}
            {!selectedTable && (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t('sql_scripts.select_table')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
