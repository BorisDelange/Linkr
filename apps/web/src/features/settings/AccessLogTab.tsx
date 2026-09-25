import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable, type DataTableColumn, type DataTableQuery } from '@/components/ui/data-table'
import { formatApiError } from '@/lib/api-client'
import {
  exportAuditLog,
  listAuditLog,
  verifyAuditLog,
  type AuditEntry,
  type AuditVerifyResult,
} from '@/lib/api/audit-log'
import { downloadBlob } from '@/lib/entity-io'
import { formatDateTimeLocale } from '@/lib/format-helpers'
import { localized } from '@/lib/localized'
import { useDataSourceStore } from '@/stores/data-source-store'

const PAGE_SIZE = 100

/** Settings → Access log. Paged, sorted and filtered on the server: the log
 *  reaches millions of lines, the browser only ever holds one page. Column ids
 *  are the server's column names. */
export function AccessLogTab() {
  const { t, i18n } = useTranslation()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null)
  const [exporting, setExporting] = useState(false)
  const query = useRef<DataTableQuery | null>(null)
  const latest = useRef(0)

  const errorText = useCallback((err: unknown) => {
    const f = formatApiError(err)
    return f.summaryKey ? t(f.summaryKey, { count: f.summaryCount ?? 0 }) : (f.summary ?? String(err))
  }, [t])

  const fetchPage = useCallback(async (q: DataTableQuery) => {
    query.current = q
    // Only the answer to the latest query may land: a slow page must not
    // overwrite the one the user asked for after it.
    const ticket = ++latest.current
    setLoading(true)
    try {
      const page = await listAuditLog(q)
      if (ticket !== latest.current) return
      setEntries(page.entries)
      setTotal(page.total)
      setFilterOptions(page.filterOptions)
      setError(null)
    } catch (err) {
      if (ticket === latest.current) setError(errorText(err))
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [errorText])

  const handleVerify = async () => {
    try {
      setVerify(await verifyAuditLog())
    } catch (err) {
      setError(errorText(err))
    }
  }

  const handleExport = async () => {
    if (!query.current) return
    setExporting(true)
    try {
      const blob = await exportAuditLog(query.current)
      downloadBlob(blob, `linkr-access-log-${new Date().toISOString().slice(0, 10)}.csv`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setExporting(false)
    }
  }

  const sourceName = useCallback((id: string | null) => {
    if (!id) return ''
    const source = dataSources.find((d) => d.id === id)
    return source ? localized(source.name, i18n.language) : id
  }, [dataSources, i18n.language])

  const columns = useMemo<DataTableColumn<AuditEntry>[]>(() => [
    {
      id: 'at',
      header: t('access_log.when'),
      accessor: (r) => r.at,
      display: (r) => formatDateTimeLocale(r.at, i18n.language),
      filter: 'text',
      size: 150,
    },
    { id: 'username', header: t('access_log.who'), accessor: (r) => r.username ?? '', filter: 'select', size: 110 },
    { id: 'via_kind', header: t('access_log.via'), accessor: (r) => r.viaKind ?? '', filter: 'select', size: 90 },
    { id: 'what', header: t('access_log.action'), accessor: (r) => r.what ?? '', filter: 'select', size: 120 },
    {
      id: 'data_source_id',
      header: t('access_log.database'),
      accessor: (r) => r.dataSourceId ?? '',
      display: (r) => sourceName(r.dataSourceId),
      filter: 'select',
      selectOptionLabel: sourceName,
      size: 150,
    },
    { id: 'summary', header: t('access_log.detail'), accessor: (r) => r.summary ?? '', filter: 'text', size: 320 },
    {
      id: 'status',
      header: t('access_log.status'),
      accessor: (r) => String(r.status ?? ''),
      filter: 'select',
      size: 80,
      center: true,
      cell: (r) => (
        <Badge variant={r.status !== null && r.status < 400 ? 'secondary' : 'outline'} className={r.status !== null && r.status >= 400 ? 'text-destructive' : undefined}>
          {r.status ?? '—'}
        </Badge>
      ),
    },
    { id: 'row_count', header: t('access_log.rows'), accessor: (r) => r.rowCount ?? '', filter: 'number', size: 80, align: 'right' },
    { id: 'client_ip', header: t('access_log.ip'), accessor: (r) => r.clientIp ?? '', filter: 'text', size: 110, hidden: true },
  ], [t, i18n.language, sourceName])

  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="text-sm">{t('access_log.title')}</CardTitle>
        <CardDescription>{t('access_log.description')}</CardDescription>
        <CardAction className="flex gap-2">
          <Button size="sm" variant="outline" onClick={handleVerify}>
            <ShieldCheck size={14} />
            {t('access_log.verify')}
          </Button>
          <Button size="sm" variant="outline" onClick={handleExport} disabled={exporting || total === 0}>
            <Download size={14} />
            {t('access_log.download')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => { if (query.current) void fetchPage(query.current) }} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
            {t('common.refresh')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {verify && (
          <div className={verify.ok ? 'flex items-center gap-2 text-xs text-muted-foreground' : 'flex items-center gap-2 text-xs text-destructive'}>
            {verify.ok ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
            {verify.ok
              ? t('access_log.verify_ok', { count: verify.checked })
              : t('access_log.verify_broken', { seq: verify.brokenAtSeq })}
          </div>
        )}
        <div className="h-[560px] overflow-hidden rounded-lg border">
          <DataTable
            data={entries}
            columns={columns}
            rowKey={(r) => r.seq}
            pageSize={PAGE_SIZE}
            cellTooltips="all"
            emptyMessage={t('access_log.empty')}
            server={{ total, onQueryChange: fetchPage, filterOptions, loading }}
          />
        </div>
      </CardContent>
    </Card>
  )
}
