import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ExternalLink, GitBranch, Globe, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { GatedButton } from '@/components/ui/gated-button'
import { FieldInfo } from '@/components/ui/field-info'
import { FieldError } from '@/components/ui/field-error'
import { SectionLabel } from '@/components/ui/section-label'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useCatalogStore } from '@/stores/catalog-store'
import { normalizeDcatMetadata } from '@/lib/dcat-ap/schema'
import {
  guessPagesProvider,
  pagesUrlFromRemote,
  PAGES_CI_PATH,
  PAGES_PROVIDERS,
  PAGES_SITE_DIR,
  type PagesProvider,
} from '@/lib/dcat-ap/pages-deployment'
import type { DataCatalog } from '@/types'

interface Props {
  catalog: DataCatalog
  publishSite: (provider: PagesProvider) => Promise<void>
  disableSite: () => Promise<void>
  siteSaving: boolean
  onOpenVersioning?: () => void
}

/** Sets up automatic deployment of the published page from the catalog's git repo. */
export function CatalogPagesCard({ catalog, publishSite, disableSite, siteSaving, onOpenVersioning }: Props) {
  const { t, i18n } = useTranslation()
  const updateCatalog = useCatalogStore((s) => s.updateCatalog)
  const canWrite = useMyWorkspaceRole().can('catalog:write')
  const remote = catalog.gitRemoteConfig?.url
  const deployment = catalog.pagesDeployment ?? null
  const [chosen, setChosen] = useState<PagesProvider | null>(null)
  const [error, setError] = useState<string | null>(null)
  const provider = chosen ?? deployment?.provider ?? guessPagesProvider(remote)

  const header = (
    <div className="flex items-center gap-1.5">
      <Globe size={14} className="text-muted-foreground" />
      <SectionLabel as="h3">{t('data_catalog.pages_title')}</SectionLabel>
      <FieldInfo text={t('data_catalog.pages_description', { site: `${PAGES_SITE_DIR}/`, ci: PAGES_CI_PATH[provider] })} />
    </div>
  )

  if (!remote) {
    return (
      <Card className="flex flex-col gap-3 p-5">
        {header}
        <p className="text-xs text-muted-foreground">{t('data_catalog.pages_not_linked')}</p>
        {onOpenVersioning && (
          <div>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onOpenVersioning}>
              <GitBranch size={14} />
              {t('data_catalog.pages_open_versioning')}
            </Button>
          </div>
        )}
      </Card>
    )
  }

  const pagesUrl = pagesUrlFromRemote(remote, provider)
  const metadata = normalizeDcatMetadata(catalog.dcatApMetadata)
  const urlInUse = pagesUrl.kind === 'known' && metadata['analytics.baseURL'] === pagesUrl.url
  // Results computed after the site was rendered are not on it yet.
  const stale = !!deployment?.updatedAt && !!catalog.lastComputedAt && catalog.lastComputedAt > deployment.updatedAt
  const providerChanged = !!deployment && deployment.provider !== provider

  // The provider picked here only becomes the catalog's once the site is regenerated.
  const run = async (action: () => Promise<void>, { commitsProvider = false } = {}) => {
    setError(null)
    try {
      await action()
      if (commitsProvider) setChosen(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      {header}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="catalog-pages-provider">{t('data_catalog.pages_provider')}</Label>
          <Select value={provider} onValueChange={(v) => setChosen(v as PagesProvider)} disabled={!canWrite || siteSaving}>
            <SelectTrigger id="catalog-pages-provider" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGES_PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>{t(`data_catalog.pages_provider_${p}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <GatedButton
            allowed={canWrite}
            notAllowedReason={t('common.insufficient_permissions')}
            size="sm"
            className="gap-1.5"
            disabled={siteSaving}
            onClick={() => void run(() => publishSite(provider), { commitsProvider: true })}
          >
            {siteSaving ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {deployment ? t('data_catalog.pages_update') : t('data_catalog.pages_enable')}
          </GatedButton>
          {deployment && (
            <GatedButton
              allowed={canWrite}
              notAllowedReason={t('common.insufficient_permissions')}
              variant="outline"
              size="sm"
              disabled={siteSaving}
              onClick={() => void run(disableSite, { commitsProvider: true })}
            >
              {t('data_catalog.pages_disable')}
            </GatedButton>
          )}
        </div>
      </div>

      {deployment?.updatedAt && (
        <p className="text-xs text-muted-foreground">
          {t('data_catalog.pages_generated_at', { date: new Date(deployment.updatedAt).toLocaleString(i18n.language) })}{' '}
          {t('data_catalog.pages_push_hint')}
          {onOpenVersioning && (
            <>
              {' '}
              <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={onOpenVersioning}>
                {t('data_catalog.pages_open_versioning')}
              </button>
            </>
          )}
        </p>
      )}
      {(stale || providerChanged) && (
        <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlert size={12} className="shrink-0" />
          {providerChanged ? t('data_catalog.pages_provider_changed') : t('data_catalog.pages_stale')}
        </p>
      )}

      <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 px-3 py-2">
        <span className="text-xs font-medium">{t('data_catalog.pages_expected_url')}</span>
        {pagesUrl.kind === 'known' ? (
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={pagesUrl.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1 break-all text-xs text-primary hover:underline"
            >
              {pagesUrl.url}
              <ExternalLink size={12} className="shrink-0" />
            </a>
            {urlInUse ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Check size={12} />
                {t('data_catalog.pages_url_in_use')}
              </span>
            ) : (
              <GatedButton
                allowed={canWrite}
                notAllowedReason={t('common.insufficient_permissions')}
                variant="outline"
                size="xs"
                onClick={() => void run(() => updateCatalog(catalog.id, {
                  dcatApMetadata: { ...metadata, 'analytics.baseURL': pagesUrl.url },
                }))}
              >
                {t('data_catalog.pages_use_url')}
              </GatedButton>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {pagesUrl.kind === 'self-hosted' && t('data_catalog.pages_url_self_hosted')}
            {pagesUrl.kind === 'provider-mismatch' && t('data_catalog.pages_url_mismatch', {
              provider: t(`data_catalog.pages_provider_${pagesUrl.hostProvider}`),
            })}
            {pagesUrl.kind === 'invalid-remote' && t('data_catalog.pages_url_invalid')}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{t(`data_catalog.pages_hint_${provider}`)}</span>
      </div>

      <FieldError message={error} />
    </Card>
  )
}
