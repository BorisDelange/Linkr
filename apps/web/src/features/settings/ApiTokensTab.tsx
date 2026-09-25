import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Ban, Plus, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { CopyIconButton } from '@/components/ui/copy-icon-button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
import {
  apiTokenStatus,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  type ApiToken,
  type ApiTokenStatus,
  type CreatedApiToken,
} from '@/lib/api/api-tokens'
import { formatApiError } from '@/lib/api-client'
import { formatDateTimeLocale } from '@/lib/format-helpers'

const EXPIRY_OPTIONS = ['30', '90', '365', 'never'] as const
type ExpiryOption = (typeof EXPIRY_OPTIONS)[number]

const STATUS_BADGE_CLASS: Record<ApiTokenStatus, string> = {
  active: '',
  expired: 'text-muted-foreground',
  revoked: 'border-destructive/40 text-destructive',
}

export function ApiTokensTab() {
  const { t, i18n } = useTranslation()
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState<ExpiryOption>('90')
  const [saving, setSaving] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedApiToken | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ApiToken | null>(null)

  const errorText = useCallback((err: unknown) => {
    const f = formatApiError(err)
    return f.summaryKey ? t(f.summaryKey, { count: f.summaryCount ?? 0 }) : (f.summary ?? String(err))
  }, [t])

  const load = useCallback(async () => {
    try {
      setTokens(await listApiTokens())
      setLoadError(null)
    } catch (err) {
      console.error('Failed to load API keys', err)
      setLoadError(errorText(err))
    }
  }, [errorText])

  useEffect(() => { void load() }, [load])

  const openCreate = () => {
    setName('')
    setExpiry('90')
    setCreateError(null)
    setCreated(null)
    setCreateOpen(true)
  }

  const handleCreateOpenChange = (open: boolean) => {
    setCreateOpen(open)
    if (!open) setCreated(null)
  }

  const handleCreate = async () => {
    setSaving(true)
    setCreateError(null)
    try {
      const token = await createApiToken(name.trim(), expiry === 'never' ? null : Number(expiry))
      setCreated(token)
      await load()
    } catch (err) {
      setCreateError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const handleRevoke = async () => {
    if (!revokeTarget) return
    const id = revokeTarget.id
    setRevokeTarget(null)
    try {
      await revokeApiToken(id)
    } finally {
      await load()
    }
  }

  const statusLabel = useCallback((s: ApiTokenStatus) => t(`api_tokens.status_${s}`), [t])

  const columns = useMemo<DataTableColumn<ApiToken>[]>(() => [
    { id: 'name', header: t('common.name'), accessor: (r) => r.name, filter: 'text', size: 180 },
    {
      id: 'prefix',
      header: t('api_tokens.key'),
      accessor: (r) => r.prefix,
      filter: 'none',
      size: 130,
      cell: (r) => <code className="font-mono text-xs text-muted-foreground">lnk_{r.prefix}…</code>,
    },
    {
      id: 'createdAt',
      header: t('api_tokens.created'),
      accessor: (r) => r.createdAt,
      display: (r) => formatDateTimeLocale(r.createdAt, i18n.language),
      filter: 'none',
      size: 140,
    },
    {
      id: 'lastUsedAt',
      header: t('api_tokens.last_used'),
      accessor: (r) => r.lastUsedAt ?? '',
      display: (r) => (r.lastUsedAt ? formatDateTimeLocale(r.lastUsedAt, i18n.language) : t('api_tokens.never_used')),
      filter: 'none',
      size: 140,
    },
    {
      id: 'expiresAt',
      header: t('api_tokens.expires'),
      accessor: (r) => r.expiresAt ?? '9999',
      display: (r) => (r.expiresAt ? formatDateTimeLocale(r.expiresAt, i18n.language) : t('api_tokens.never_expires')),
      filter: 'none',
      size: 140,
    },
    {
      id: 'status',
      header: t('api_tokens.status'),
      accessor: (r) => apiTokenStatus(r),
      filter: 'select',
      selectOptionLabel: (v) => statusLabel(v as ApiTokenStatus),
      size: 100,
      center: true,
      cell: (r) => {
        const status = apiTokenStatus(r)
        return (
          <Badge variant={status === 'active' ? 'secondary' : 'outline'} className={STATUS_BADGE_CLASS[status]}>
            {statusLabel(status)}
          </Badge>
        )
      },
    },
    {
      id: 'actions',
      header: '',
      accessor: () => '',
      filter: 'none',
      sortable: false,
      size: 48,
      cell: (r) => apiTokenStatus(r) === 'revoked' ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={() => setRevokeTarget(r)} aria-label={t('api_tokens.revoke')}>
              <Ban size={12} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('api_tokens.revoke')}</TooltipContent>
        </Tooltip>
      ),
    },
  ], [t, i18n.language, statusLabel])

  return (
    <TooltipProvider>
      <Card className="gap-2">
        <CardHeader>
          <CardTitle className="text-sm">{t('api_tokens.title')}</CardTitle>
          <CardDescription>{t('api_tokens.description')}</CardDescription>
          <CardAction>
            <Button size="sm" onClick={openCreate}>
              <Plus size={14} />
              {t('api_tokens.new')}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-2">
          {loadError && <p className="text-xs text-destructive">{loadError}</p>}
          <div className="h-[360px] overflow-hidden rounded-lg border">
            <DataTable
              data={tokens}
              columns={columns}
              rowKey={(r) => r.id}
              pageSize={100}
              emptyMessage={t('api_tokens.empty')}
            />
          </div>
        </CardContent>
      </Card>

      {created ? (
        <DialogShell
          open={createOpen}
          onOpenChange={handleCreateOpenChange}
          title={t('api_tokens.created_title')}
          description={t('api_tokens.created_description', { name: created.name })}
        >
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-destructive" />
            <p className="text-xs text-destructive">{t('api_tokens.shown_once_warning')}</p>
          </div>
          <FormField label={t('api_tokens.key')}>
            {({ id }) => (
              <div className="flex items-center gap-2">
                <Input id={id} value={created.token} readOnly className="font-mono" onFocus={(e) => e.currentTarget.select()} />
                <CopyIconButton text={created.token} size={14} className="p-1.5 hover:bg-accent" />
              </div>
            )}
          </FormField>
          <p className="text-xs text-muted-foreground">{t('api_tokens.usage_hint')}</p>
        </DialogShell>
      ) : (
        <DialogShell
          open={createOpen}
          onOpenChange={handleCreateOpenChange}
          title={t('api_tokens.create_title')}
          description={t('api_tokens.create_description')}
          onConfirm={handleCreate}
          confirmLabel={t('common.create')}
          confirmDisabled={!name.trim()}
          busy={saving}
        >
          <FormField label={t('common.name')} required hint={t('api_tokens.name_hint')}>
            {({ id }) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('api_tokens.name_placeholder')}
                maxLength={255}
                autoFocus
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField label={t('api_tokens.expiration')}>
            {({ id }) => (
              <Select value={expiry} onValueChange={(v) => setExpiry(v as ExpiryOption)}>
                <SelectTrigger id={id} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((o) => (
                    <SelectItem key={o} value={o}>{t(`api_tokens.expiry_${o}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          {createError && <p className="text-xs text-destructive">{createError}</p>}
        </DialogShell>
      )}

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => { if (!open) setRevokeTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('api_tokens.revoke_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('api_tokens.revoke_description', { name: revokeTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRevoke} className="bg-destructive text-white hover:bg-destructive/90">
              {t('api_tokens.revoke')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}
