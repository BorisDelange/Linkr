import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
import { formatApiError } from '@/lib/api-client'
import {
  auditEntriesToCsv,
  listAuditLog,
  verifyAuditLog,
  type AuditEntry,
  type AuditVerifyResult,
} from '@/lib/api/audit-log'
import { downloadBlob } from '@/lib/entity-io'
import { formatDateTimeLocale } from '@/lib/format-helpers'
import { localized } from '@/lib/localized'
import { useDataSourceStore } from '@/stores/data-source-store'

const LOADED = 1000

/** Settings → Access log: the latest entries of the instance's access log. */
export function AccessLogTab() {
  const { t, i18n } = useTranslation()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null)

  const errorText = useCallback((err: unknown) => {
    const f = formatApiError(err)
    return f.summaryKey ? t(f.summaryKey, { count: f.summaryCount ?? 0 }) : (f.summary ?? String(err))
  }, [t])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const page = await listAuditLog(LOADED)
      setEntries(page.entries)
      setTotal(page.total)
      setError(null)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [errorText])

  useEffect(() => { void load() }, [load])

  const handleVerify = async () => {
    try {
      setVerify(await verifyAuditLog())
    } catch (err) {
      setError(errorText(err))
    }
  }

  const handleDownload = () => {
    const csv = auditEntriesToCsv(entries)
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `linkr-access-log-${new Date().toISOString().slice(0, 10)}.csv`)
  }

  const sourceName = useCallback((id: string | null) => {
    if (!id) return ''
    const source = dataSources.find((d) => d.id === id)
    return source ? localized(source.name, i18n.language) : id
  }, [dataSources, i18n.language])

  const columns = useMemo<ConceptColumn<AuditEntry>[]>(() => [
    {
      id: 'at',
      header: t('access_log.when'),
      accessor: (r) => r.at,
      display: (r) => formatDateTimeLocale(r.at, i18n.language),
      filter: 'text',
      size: 150,
    },
    { id: 'username', header: t('access_log.who'), accessor: (r) => r.username ?? '', filter: 'select', size: 110 },
    { id: 'via', header: t('access_log.via'), accessor: (r) => (r.via?.startsWith('job:') ? 'job' : (r.via ?? '')), filter: 'select', size: 90 },
    { id: 'action', header: t('access_log.action'), accessor: (r) => r.action ?? r.method ?? '', filter: 'select', size: 120 },
    { id: 'database', header: t('access_log.database'), accessor: (r) => sourceName(r.dataSourceId), filter: 'select', size: 150 },
    { id: 'detail', header: t('access_log.detail'), accessor: (r) => r.detail ?? r.route ?? '', filter: 'text', size: 320 },
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
    { id: 'rows', header: t('access_log.rows'), accessor: (r) => r.rowCount ?? -1, display: (r) => (r.rowCount === null ? '' : String(r.rowCount)), filter: 'number', size: 80, align: 'right' },
    { id: 'ip', header: t('access_log.ip'), accessor: (r) => r.clientIp ?? '', filter: 'text', size: 110, hidden: true },
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
          <Button size="sm" variant="outline" onClick={handleDownload} disabled={entries.length === 0}>
            <Download size={14} />
            {t('access_log.download')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
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
        {total > entries.length && (
          <p className="text-xs text-muted-foreground">{t('access_log.showing_latest', { shown: entries.length, total })}</p>
        )}
        <div className="h-[560px] overflow-hidden rounded-lg border">
          <ConceptDataTable
            data={entries}
            columns={columns}
            rowKey={(r) => String(r.seq)}
            pageSize={100}
            cellTooltips="all"
            emptyMessage={t('access_log.empty')}
          />
        </div>
      </CardContent>
    </Card>
  )
}
