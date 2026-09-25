import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { formatApiError } from '@/lib/api-client'
import { forgetMyDatabaseLogin, listMyDatabaseLogins, type DatabaseLoginEntry } from '@/lib/api/database-logins'
import { formatDateTimeLocale } from '@/lib/format-helpers'
import { localized } from '@/lib/localized'
import { DatabaseLoginDialog } from './DatabaseLoginDialog'

/** Profile → Database accounts: the user's own logins to external databases. */
export function DatabaseLoginsTab() {
  const { t, i18n } = useTranslation()
  const [logins, setLogins] = useState<DatabaseLoginEntry[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ entry: DatabaseLoginEntry; opening: number } | null>(null)
  const [forgetTarget, setForgetTarget] = useState<DatabaseLoginEntry | null>(null)

  const load = useCallback(async () => {
    try {
      setLogins(await listMyDatabaseLogins())
      setLoadError(null)
    } catch (err) {
      const f = formatApiError(err)
      setLoadError(f.summaryKey ? t(f.summaryKey, { count: f.summaryCount ?? 0 }) : (f.summary ?? String(err)))
    }
  }, [t])

  useEffect(() => { void load() }, [load])

  const handleForget = async () => {
    if (!forgetTarget) return
    const id = forgetTarget.dataSourceId
    setForgetTarget(null)
    try {
      await forgetMyDatabaseLogin(id)
    } finally {
      await load()
    }
  }

  const columns = useMemo<ConceptColumn<DatabaseLoginEntry>[]>(() => [
    { id: 'name', header: t('database_logins.database'), accessor: (r) => localized(r.name, i18n.language), filter: 'text', size: 220 },
    { id: 'username', header: t('database_logins.username'), accessor: (r) => r.username, filter: 'text', size: 160 },
    {
      id: 'remembered',
      header: t('database_logins.kept'),
      accessor: (r) => (r.remembered ? 'remembered' : 'session'),
      filter: 'select',
      selectOptionLabel: (v) => t(`database_logins.kept_${v}`),
      size: 140,
      center: true,
      cell: (r) => (
        <Badge variant={r.remembered ? 'secondary' : 'outline'}>
          {t(`database_logins.kept_${r.remembered ? 'remembered' : 'session'}`)}
        </Badge>
      ),
    },
    {
      id: 'lastUsedAt',
      header: t('database_logins.last_used'),
      accessor: (r) => r.lastUsedAt ?? '',
      display: (r) => (r.lastUsedAt ? formatDateTimeLocale(r.lastUsedAt, i18n.language) : '—'),
      filter: 'none',
      size: 150,
    },
    {
      id: 'actions',
      header: '',
      accessor: () => '',
      filter: 'none',
      sortable: false,
      size: 72,
      cell: (r) => (
        <div className="flex justify-end gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={() => setEditing({ entry: r, opening: Date.now() })} aria-label={t('database_logins.change')}>
                <Pencil size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t('database_logins.change')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={() => setForgetTarget(r)} aria-label={t('database_logins.forget')}>
                <Trash2 size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t('database_logins.forget')}</TooltipContent>
          </Tooltip>
        </div>
      ),
    },
  ], [t, i18n.language])

  return (
    <TooltipProvider>
      <Card className="gap-2">
        <CardHeader>
          <CardTitle className="text-sm">{t('database_logins.title')}</CardTitle>
          <CardDescription>{t('database_logins.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {loadError && <p className="text-xs text-destructive">{loadError}</p>}
          <div className="h-[360px] overflow-hidden rounded-lg border">
            <ConceptDataTable
              data={logins}
              columns={columns}
              rowKey={(r) => r.dataSourceId}
              pageSize={100}
              emptyMessage={t('database_logins.empty')}
            />
          </div>
        </CardContent>
      </Card>

      {editing && (
        <DatabaseLoginDialog
          key={editing.opening}
          dataSourceId={editing.entry.dataSourceId}
          initialUsername={editing.entry.username}
          open
          onOpenChange={(open) => { if (!open) setEditing(null) }}
          onSaved={() => { setEditing(null); void load() }}
        />
      )}

      <AlertDialog open={!!forgetTarget} onOpenChange={(open) => { if (!open) setForgetTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('database_logins.forget_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('database_logins.forget_description', { name: forgetTarget ? localized(forgetTarget.name, i18n.language) : '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleForget} className="bg-destructive text-white hover:bg-destructive/90">
              {t('database_logins.forget')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}
