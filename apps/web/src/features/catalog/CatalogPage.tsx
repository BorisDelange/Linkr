import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, Loader2, RefreshCw, Store } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { isServerMode } from '@/lib/api-client'
import { formatDate } from '@/lib/format-helpers'
import { paths } from '@/lib/paths'
import { getCatalogSource, loadCatalogTargetWorkspace, saveCatalogTargetWorkspace } from '@/lib/catalog/settings'
import { findInstalled, type InstalledInfo } from '@/lib/catalog/installed'
import { useCatalog } from '@/hooks/use-catalog'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { CatalogBrowser } from './CatalogBrowser'
import { CatalogInstallOutcome } from './CatalogInstallDialog'
import { useCatalogInstall } from './use-catalog-install'
import type { CatalogEntry } from '@/lib/catalog/types'

export function CatalogPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const language = useAppStore((s) => s.language)
  const { entries, loaded, loading, error, fetchedAt, update, load, refresh } = useCatalog()

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces)
  /** Explicit pick only; the effective workspace is derived below. Restored from
   *  localStorage so leaving the page and coming back keeps the chosen target. */
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState(loadCatalogTargetWorkspace)
  /** Installed copies in the selected workspace, keyed by catalog entry id. */
  const [installed, setInstalled] = useState<Record<string, InstalledInfo>>({})
  /** Bumped after an install to re-read storage; nothing else changes. */
  const [installedNonce, setInstalledNonce] = useState(0)

  const serverMode = isServerMode()
  const source = getCatalogSource()

  useEffect(() => { void loadWorkspaces() }, [loadWorkspaces])

  // Derived, not synced into state: falls back to the workspace the user was last in,
  // then to the only one there is, so the common single-workspace case never forces a
  // pick. A stale pick (workspace deleted) resolves back to the fallback on its own.
  const workspaceId = useMemo(() => {
    if (pickedWorkspaceId && workspaces.some((w) => w.id === pickedWorkspaceId)) return pickedWorkspaceId
    if (activeWorkspaceId && workspaces.some((w) => w.id === activeWorkspaceId)) return activeWorkspaceId
    return workspaces.length === 1 ? workspaces[0]!.id : ''
  }, [pickedWorkspaceId, workspaces, activeWorkspaceId])

  // Installing writes straight from the card; only a conflict or a failure opens a dialog.
  const bumpInstalled = useCallback(() => setInstalledNonce((n) => n + 1), [])
  const inst = useCatalogInstall(workspaceId, bumpInstalled)

  /**
   * Where an installed entity lives in the app — the entity itself, not the list page
   * it sits on. Types with no detail route of their own (sql collections, data
   * catalogs) return undefined, and their card keeps opening the repo, which is more
   * useful than a list that does not say which row was just installed.
   */
  const openInApp = useCallback(
    (entry: CatalogEntry, info?: InstalledInfo): (() => void) | undefined => {
      if (!info || !workspaceId) return undefined
      const to =
        entry.type === 'project' ? paths.projectSummary(workspaceId, info.id)
        : entry.type === 'mapping-project' ? paths.warehouseConceptMappingProject(workspaceId, info.id)
        : entry.type === 'etl-pipeline' ? paths.warehouseEtlPipeline(workspaceId, info.id)
        : entry.type === 'dq-rule-set' ? paths.warehouseDqRuleSet(workspaceId, info.id)
        : entry.type === 'schema-preset' ? paths.warehouseSchema(workspaceId, info.id)
        : null
      return to ? () => navigate(to) : undefined
    },
    [workspaceId, navigate],
  )

  // Which entries are already installed can only be answered by reading storage, so it
  // is a genuine external-system sync rather than derivable state.
  useEffect(() => {
    let cancelled = false
    const lookup = !workspaceId || !entries.length
      ? Promise.resolve({})
      : findInstalled(entries, workspaceId)
    void lookup.then((found) => { if (!cancelled) setInstalled(found) })
    return () => { cancelled = true }
  }, [entries, workspaceId, installedNonce])

  const updateSummary = () => {
    if (!update) return ''
    const parts: string[] = []
    if (update.added.length) parts.push(t('catalog.update_new', { count: update.added.length }))
    if (update.modified.length) parts.push(t('catalog.update_modified', { count: update.modified.length }))
    if (update.removed.length) parts.push(t('catalog.update_removed', { count: update.removed.length }))
    return parts.join(', ')
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-foreground">{t('catalog.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('catalog.description')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('catalog.contribute')}{' '}
              <a
                href={source.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {source.project}
                <ExternalLink size={11} />
              </a>
            </p>
          </div>
          {loaded && (
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t('catalog.last_updated', { date: formatDate(fetchedAt ?? undefined, language) })}
              </span>
              <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={refresh} disabled={loading}>
                {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {t('catalog.refresh')}
              </Button>
            </div>
          )}
        </div>

        {loaded && update && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-foreground">{t('catalog.updates_available', { summary: updateSummary() })}</span>
            <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={refresh} disabled={loading}>
              {t('catalog.update_now')}
            </Button>
          </div>
        )}

        {!loaded ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <Store size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">{t('catalog.not_loaded')}</p>
              <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                {t('catalog.not_loaded_description', { host: source.host })}
              </p>
              <Button size="sm" className="mt-4 gap-1" onClick={load} disabled={loading}>
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {t('catalog.load')}
              </Button>
              {error && (
                <p className="mt-3 text-xs text-destructive">{t(`catalog.error_${error.replace(/-/g, '_')}`)}</p>
              )}
            </div>
          </Card>
        ) : (
          <CatalogBrowser
            className="mt-6"
            entries={entries}
            language={language}
            installed={installed}
            serverMode={serverMode}
            hasWorkspace={!!workspaceId}
            busyId={inst.busyId}
            onInstall={(entry) => void inst.install(entry, installed[entry.id])}
            openInApp={(entry) => openInApp(entry, installed[entry.id])}
            toolbarExtra={
              /* Installing targets one workspace, and whether an entry is already
                 installed is answered per workspace — so the choice belongs here, next
                 to the list it qualifies, rather than inside the install dialog. */
              serverMode && workspaces.length > 0 ? (
                <Select
                  value={workspaceId}
                  onValueChange={(id) => { setPickedWorkspaceId(id); saveCatalogTargetWorkspace(id) }}
                >
                  <SelectTrigger className="h-9 w-52 shrink-0" aria-label={t('catalog.install_workspace')}>
                    <SelectValue placeholder={t('catalog.install_workspace_placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.map((ws) => (
                      <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null
            }
          />
        )}

        {error && loaded && (
          <p className="mt-3 text-xs text-destructive">{t(`catalog.error_${error.replace(/-/g, '_')}`)}</p>
        )}

      </div>

      <CatalogInstallOutcome install={inst} language={language} />
    </div>
  )
}
