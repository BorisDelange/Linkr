import { useCallback, useEffect, useMemo, useState } from 'react'
import JSZip from 'jszip'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ClipboardCheck, Database, ShieldCheck } from 'lucide-react'
import { ListPageToolbar, type FilterGroup } from '@/components/ui/list-page-toolbar'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { usePersistedSort } from '@/lib/use-persisted-sort'
import { cn } from '@/lib/utils'
import { ENTITY_COLORS } from '@/lib/entity-colors'
import { paths } from '@/lib/paths'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { badgeFilterOptions } from '@/lib/badge-filter-options'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { localized, setLocalized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { buildDqProfileFolder, parseImportZip, readImportedManifest, resolveProfileSources } from '@/lib/entity-io'
import { MissingManifestError } from '@/lib/app-version-compat'
import { withEntityDocs } from '@/lib/entity-docs-pull'
import { findLineageMatch, resolveByLineage, resolvePointer } from '@/lib/import-identity'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import type { ImportGitRemote } from '@/components/ui/import-source-dialog'
import { useAppStore } from '@/stores/app-store'
import { useDqProfileStore } from '@/stores/dq-profile-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { TruncatedText } from '@/components/ui/truncated-text'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { ListPageTemplate } from '../ListPageTemplate'
import { CreateDqProfileDialog } from './CreateDqProfileDialog'
import { useDqProfileActions } from './use-dq-profile-actions'
import { DqBackToHome } from './DqBackToHome'
import { scoreColor } from './DqConstants'
import type { DqProfile } from '@/types'

export function DqProfileListPage() {
  const { t, i18n } = useTranslation()
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { atLeast } = useMyWorkspaceRole()
  const { profiles: allProfiles, profilesLoaded, loadProfiles } = useDqProfileStore()
  const profileActions = useDqProfileActions()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  useEffect(() => {
    if (!profilesLoaded) void loadProfiles()
  }, [profilesLoaded, loadProfiles])

  const profiles = useMemo(
    () => (activeWorkspaceId ? allProfiles.filter((p) => p.workspaceId === activeWorkspaceId) : []),
    [allProfiles, activeWorkspaceId],
  )

  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = usePersistedSort('dq-profiles')
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const kept = profiles.filter((p) => {
      if (q && !`${localized(p.name, language)} ${localized(p.description, language)}`.toLowerCase().includes(q)) return false
      if (badgeFilter.length > 0) {
        const labels = new Set((p.badges ?? []).map((b) => localized(b.label, language)))
        if (!badgeFilter.some((l) => labels.has(l))) return false
      }
      return true
    })
    return applySort(kept, sort, {
      name: (p) => localized(p.name, language),
      createdAt: (p) => p.createdAt,
      updatedAt: (p) => p.updatedAt,
    })
  }, [profiles, searchQuery, badgeFilter, sort, language])

  const badgeCategories = useBadgeCategories()
  const allBadges = useMemo(() => {
    const byLabel = new Map<string, string>()
    for (const p of profiles) for (const b of p.badges ?? []) {
      const label = localized(b.label, language)
      if (label && !byLabel.has(label)) byLabel.set(label, b.color)
    }
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, color]) => ({ label, color }))
  }, [profiles, language])

  const filterGroups: FilterGroup[] = allBadges.length > 0 ? [{
    key: 'badges',
    label: t('common.badges'),
    selected: badgeFilter,
    onChange: setBadgeFilter,
    options: badgeFilterOptions(allBadges, badgeCategories, i18n.language, t('badge_categories.no_category')),
  }] : []

  // --- Import ---
  const [conflict, setConflict] = useState<{ name: string; pending: DqProfile } | null>(null)

  const doImport = useCallback(async (p: DqProfile, duplicate: boolean) => {
    if (!activeWorkspaceId) return
    const storage = getStorage()
    const now = new Date().toISOString()
    // Exports carry no `id`: lineage says which row a re-import lands on.
    const { id, replaces } = resolveByLineage(
      duplicate ? [] : await storage.dqProfiles.getAll().catch(() => []),
      p,
      activeWorkspaceId,
      duplicate,
    )
    // The cloned HEAD rides in on gitRemoteConfig.syncedOid: anchor on it, never store it.
    const syncedOid = p.gitRemoteConfig?.syncedOid
    const gitRemoteConfig = p.gitRemoteConfig
      ? { url: p.gitRemoteConfig.url, branch: p.gitRemoteConfig.branch, authToken: p.gitRemoteConfig.authToken }
      : undefined
    const database = p.dataSourceRef
      ? resolvePointer(await storage.dataSources.getAll(), p.dataSourceRef, activeWorkspaceId)
      : undefined
    const entity: DqProfile = {
      ...p,
      gitRemoteConfig,
      id,
      workspaceId: activeWorkspaceId,
      dataSourceId: database?.id ?? '',
      sources: await resolveProfileSources(p.sources, storage, activeWorkspaceId),
      status: p.status ?? 'draft',
      name: duplicate ? setLocalized(p.name, language, `${localized(p.name, language)} (copy)`) : p.name,
      updatedAt: now,
      ...(duplicate || !p.createdAt ? { createdAt: now } : {}),
    }
    if (replaces) await storage.dqProfiles.delete(replaces).catch(() => {})
    await storage.dqProfiles.create(entity)
    if (syncedOid) {
      try {
        const { gitSetSyncState } = await import('@/lib/api/git')
        await gitSetSyncState('dq-profiles', id, gitRemoteConfig?.branch ?? 'main', syncedOid)
      } catch { /* left unanchored: a later clean sync still adopts it */ }
    }
    await loadProfiles()
  }, [activeWorkspaceId, language, loadProfiles])

  /** Duplicate = export to a ZIP and re-import it as a copy, through the import's rules. */
  const handleDuplicate = useCallback(async (p: DqProfile) => {
    const zip = new JSZip()
    await buildDqProfileFolder(zip, '', p, getStorage())
    const parsed = await parseImportZip(new File([await zip.generateAsync({ type: 'blob' })], 'dup.zip'))
    const copy = readImportedManifest<DqProfile>(parsed, 'dq-profile')
    if (!copy) return
    withEntityDocs(copy, parsed)
    await doImport(copy, true)
  }, [doImport])

  const handleImport = useCallback(async (file: File, gitRemote?: ImportGitRemote) => {
    const parsed = await parseImportZip(file)
    const p = readImportedManifest<DqProfile>(parsed, 'dq-profile')
    if (!p) throw new MissingManifestError('dq-profile')
    if (gitRemote) p.gitRemoteConfig = gitRemote
    withEntityDocs(p, parsed)
    const existing = activeWorkspaceId
      ? findLineageMatch(await getStorage().dqProfiles.getAll().catch(() => []), p, activeWorkspaceId)
      : undefined
    if (existing) setConflict({ name: localized(existing.name, language), pending: p })
    else await doImport(p, false)
  }, [activeWorkspaceId, doImport, language])

  const sourceName = (id: string) => localized(dataSources.find((ds) => ds.id === id)?.name, language) || '—'
  const open = (id: string, tab?: string) => {
    if (activeWorkspaceId) navigate(`${paths.warehouseDqProfile(activeWorkspaceId, id)}${tab ? `?tab=${tab}` : ''}`)
  }

  return (
    <>
    <ImportConflictDialog
      open={!!conflict}
      onOpenChange={(o) => { if (!o) setConflict(null) }}
      existingName={conflict?.name ?? ''}
      onDuplicate={() => { if (conflict) void doImport(conflict.pending, true); setConflict(null) }}
      onOverwrite={() => { if (conflict) void doImport(conflict.pending, false); setConflict(null) }}
    />
    <ListPageTemplate<DqProfile>
      canEdit={atLeast('editor')}
      canDelete={atLeast('owner')}
      titleKey="data_quality.profiles_title"
      descriptionKey="data_quality.profiles_description"
      newButtonKey="data_quality.new_profile"
      emptyTitleKey="data_quality.no_profiles"
      emptyDescriptionKey="data_quality.no_profiles_description"
      deleteConfirmTitleKey={profileActions.deleteConfirmTitleKey}
      deleteConfirmDescriptionKey={profileActions.deleteConfirmDescriptionKey}
      emptyIcon={ClipboardCheck}
      items={filtered}
      backAction={activeWorkspaceId ? <DqBackToHome workspaceId={activeWorkspaceId} /> : undefined}
      toolbar={
        profiles.length > 0 ? (
          <ListPageToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('common.search')}
            filterGroups={filterGroups}
            sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
          />
        ) : undefined
      }
      onNavigate={(id) => open(id)}
      onDelete={profileActions.onDelete}
      onDuplicate={handleDuplicate}
      onExport={profileActions.onExport}
      getGitRemote={profileActions.getGitRemote}
      onSaveGitRemote={profileActions.onSaveGitRemote}
      exportSupportsIncludeData={profileActions.exportSupportsIncludeData}
      syncScope="dq-profiles"
      onImport={handleImport}
      docs={profileActions.docs}
      onOpenDocs={(item, tab) => open(item.id, tab)}
      onVersioningOverride={(item) => open(item.id, 'versioning')}
      renderCardBody={(p, actionsMenu) => (
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', ENTITY_COLORS['dq-profile'].bg)}>
              <ClipboardCheck size={20} className={ENTITY_COLORS['dq-profile'].icon} />
            </div>
            <TruncatedText text={localized(p.name, language)} className="min-w-0 flex-1 text-sm font-medium" />
            {p.lastScore != null && (
              <span className={cn('shrink-0 font-mono text-xs font-medium', scoreColor(p.lastScore))}>
                {p.lastScore}%
              </span>
            )}
            <div className="ml-auto shrink-0">{actionsMenu}</div>
          </div>
          <div className="mt-2 h-4">
            {localized(p.description, language) && (
              <TruncatedText text={localized(p.description, language)} className="text-xs text-muted-foreground" />
            )}
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5">
              <Database size={12} className="shrink-0" />
              <span className="truncate">{sourceName(p.dataSourceId)}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <ShieldCheck size={12} />
              {t('data_quality.profile_rule_set_count', { count: p.sources.length })}
            </span>
          </div>
          <BadgeStrip badges={p.badges ?? []} className="mt-1.5 h-5" />
        </div>
      )}
      renderCreateDialog={({ open: dialogOpen, onOpenChange, onCreated }) => (
        <CreateDqProfileDialog open={dialogOpen} onOpenChange={onOpenChange} onCreated={onCreated} />
      )}
      renderEditDialog={profileActions.renderEditDialog}
    />
    </>
  )
}
