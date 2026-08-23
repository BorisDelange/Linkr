import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ShieldCheck, Database } from 'lucide-react'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { cn } from '@/lib/utils'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { badgeFilterOptions } from '@/lib/badge-filter-options'
import { localized, setLocalized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { useDqStore } from '@/stores/dq-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { getStorage } from '@/lib/storage'
import JSZip from 'jszip'
import { buildDqRuleSetFolder, parseImportZip } from '@/lib/entity-io'
import { withEntityDocs } from '@/lib/entity-docs-pull'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import type { ImportGitRemote } from '@/components/ui/import-source-dialog'
import { TruncatedText } from '@/components/ui/truncated-text'
import { ListPageTemplate } from '../ListPageTemplate'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { CreateDqRuleSetDialog } from './CreateDqRuleSetDialog'
import { useDqRuleSetActions } from './use-dq-rule-set-actions'
import type { DqRuleSet } from '@/types'

function scoreColor(score?: number) {
  if (score == null) return ''
  if (score >= 95) return 'text-emerald-600 dark:text-emerald-400'
  if (score >= 80) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

export function DqRuleSetListPage() {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { atLeast } = useMyWorkspaceRole()
  const { dqRuleSetsLoaded, loadDqRuleSets, dqRuleSets } = useDqStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const dqActions = useDqRuleSetActions()

  useEffect(() => {
    if (!dqRuleSetsLoaded) loadDqRuleSets()
  }, [dqRuleSetsLoaded, loadDqRuleSets])

  const ruleSets = useMemo(
    () => (activeWorkspaceId ? dqRuleSets.filter((s) => s.workspaceId === activeWorkspaceId) : []),
    [dqRuleSets, activeWorkspaceId],
  )

  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const filteredRuleSets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const filtered = ruleSets.filter((rs) => {
      if (q && !`${localized(rs.name, language)} ${localized(rs.description, language)}`.toLowerCase().includes(q)) return false
      if (badgeFilter.length > 0) {
        const labels = new Set((rs.badges ?? []).map((b) => localized(b.label, language)))
        if (!badgeFilter.some((l) => labels.has(l))) return false
      }
      return true
    })
    return applySort(filtered, sort, {
      name: (rs) => localized(rs.name, language),
      createdAt: (rs) => rs.createdAt,
      updatedAt: (rs) => rs.updatedAt,
    })
  }, [ruleSets, searchQuery, badgeFilter, sort, language])

  // Distinct badges across the workspace's items, first-seen colour per label so the
  // filter options match the chips drawn on the cards.
  const allBadges = useMemo(() => {
    const byLabel = new Map<string, string>()
    for (const rs of ruleSets) for (const b of rs.badges ?? []) {
      const label = localized(b.label, language)
      if (label && !byLabel.has(label)) byLabel.set(label, b.color)
    }
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, color]) => ({ label, color }))
  }, [ruleSets, language])

  const filterGroups: FilterGroup[] = allBadges.length > 0 ? [{
    key: 'badges',
    label: t('common.badges'),
    selected: badgeFilter,
    onChange: setBadgeFilter,
    options: badgeFilterOptions(allBadges, badgeCategories, i18n.language, t('badge_categories.no_category')),
  }] : []

  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? '—'

  // --- Import ---
  const [conflict, setConflict] = useState<{ name: string; pending: DqRuleSet; pendingChecks: import('@/types').DqCustomCheck[] } | null>(null)

  const doImport = useCallback(async (rs: DqRuleSet, checks: import('@/types').DqCustomCheck[], duplicate: boolean) => {
    const now = new Date().toISOString()
    const id = duplicate ? crypto.randomUUID() : rs.id
    // The cloned HEAD rides in on gitRemoteConfig.syncedOid but must not be
    // persisted — capture it for anchoring, then strip it from the stored config.
    const syncedOid = rs.gitRemoteConfig?.syncedOid
    const gitRemoteConfig = rs.gitRemoteConfig
      ? { url: rs.gitRemoteConfig.url, branch: rs.gitRemoteConfig.branch, authToken: rs.gitRemoteConfig.authToken }
      : rs.gitRemoteConfig
    const entity: DqRuleSet = {
      ...rs,
      gitRemoteConfig,
      id,
      workspaceId: activeWorkspaceId ?? rs.workspaceId,
      name: duplicate ? setLocalized(rs.name, language, `${localized(rs.name, language)} (copy)`) : rs.name,
      updatedAt: now,
      ...(duplicate ? { createdAt: now } : {}),
    }
    if (!duplicate) {
      // Overwrite of an existing rule set: clear its checks/row first. A fresh
      // import (git clone of a rule set not on this server) has nothing to clear —
      // the check delete 404s ("Not found") on the missing rule set, so swallow it
      // like the row delete below.
      await getStorage().dqCustomChecks.deleteByRuleSet(rs.id).catch(() => {})
      await getStorage().dqRuleSets.delete(rs.id).catch(() => {})
    }
    await getStorage().dqRuleSets.create(entity)
    // Anchor sync state to the commit we cloned (server-mode git import only): it's
    // the base this workspace imported from, so a later push elsewhere is detected
    // as "behind". Best-effort — a failure just means no banner yet.
    if (syncedOid) {
      try {
        const { gitSetSyncState } = await import('@/lib/api/git')
        await gitSetSyncState('dq-rule-sets', id, gitRemoteConfig?.branch ?? 'main', syncedOid)
      } catch { /* leave unanchored — lazy adoption may still catch a clean sync */ }
    }
    for (const c of checks) {
      await getStorage().dqCustomChecks.create({
        ...c,
        id: duplicate ? crypto.randomUUID() : c.id,
        ruleSetId: id,
      })
    }
    await loadDqRuleSets()
  }, [activeWorkspaceId, loadDqRuleSets])

  /** Duplicate = export to a ZIP and re-import it in duplicate mode, reusing the
   *  import path's cloning rules rather than repeating them here. */
  const handleDuplicate = useCallback(async (rs: DqRuleSet) => {
    const zip = new JSZip()
    await buildDqRuleSetFolder(zip, '', rs, getStorage())
    const blob = await zip.generateAsync({ type: 'blob' })
    const parsed = await parseImportZip(new File([blob], 'dup.zip'))
    const parsedRs = parsed['rule-set.json'] as DqRuleSet | undefined
    if (!parsedRs?.id) return
    withEntityDocs(parsedRs, parsed)
    const checks = (parsed['checks.json'] ?? []) as import('@/types').DqCustomCheck[]
    await doImport(parsedRs, checks, true)
  }, [doImport])

  const handleImport = useCallback(async (file: File, gitRemote?: ImportGitRemote) => {
    const parsed = await parseImportZip(file)
    // One layout: buildDqRuleSetFolder, whether the ZIP came from an export or a
    // clone. The standalone export used to write `ruleset.json` instead — it now
    // calls the same builder, so there is a single name to read.
    const rs = parsed['rule-set.json'] as DqRuleSet | undefined
    if (!rs?.id) return
    // Imported from a git repo → pre-link the Versioning page to that repo (with
    // the token, if supplied). The export strips gitRemoteConfig, so it's only
    // ever set from the import source.
    if (gitRemote) rs.gitRemoteConfig = gitRemote
    withEntityDocs(rs, parsed)
    const checks = (parsed['checks.json'] ?? []) as import('@/types').DqCustomCheck[]
    const existing = await getStorage().dqRuleSets.getById(rs.id)
    if (existing) {
      setConflict({ name: localized(existing.name, language), pending: rs, pendingChecks: checks })
    } else {
      await doImport(rs, checks, false)
    }
  }, [doImport])

  return (
    <>
    <ImportConflictDialog
      open={!!conflict}
      onOpenChange={(open) => { if (!open) setConflict(null) }}
      existingName={conflict?.name ?? ''}
      onDuplicate={() => { if (conflict) doImport(conflict.pending, conflict.pendingChecks, true); setConflict(null) }}
      onOverwrite={() => { if (conflict) doImport(conflict.pending, conflict.pendingChecks, false); setConflict(null) }}
    />
    <ListPageTemplate<DqRuleSet>
      canEdit={atLeast('editor')}
      canDelete={atLeast('owner')}
      titleKey="data_quality.rs_title"
      descriptionKey="data_quality.rs_description"
      newButtonKey="data_quality.new_rule_set"
      emptyTitleKey="data_quality.no_rule_sets"
      emptyDescriptionKey="data_quality.no_rule_sets_description"
      deleteConfirmTitleKey={dqActions.deleteConfirmTitleKey}
      deleteConfirmDescriptionKey={dqActions.deleteConfirmDescriptionKey}
      emptyIcon={ShieldCheck}
      items={filteredRuleSets}
      toolbar={
        ruleSets.length > 0 ? (
          <ListPageToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('common.search')}
            filterGroups={filterGroups}
            sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
          />
        ) : undefined
      }
      onNavigate={(id) => navigate(id)}
      onDelete={dqActions.onDelete}
      onDuplicate={handleDuplicate}
      onExport={dqActions.onExport}
      getGitRemote={dqActions.getGitRemote}
      docs={dqActions.docs}
      onSaveGitRemote={dqActions.onSaveGitRemote}
      exportSupportsIncludeData={dqActions.exportSupportsIncludeData}
      syncScope="dq-rule-sets"
      onImport={handleImport}
      renderCardBody={(rs, actionsMenu) => {
        return (
          <div className="min-w-0 flex-1">
            {/* Row 1: icon + title (+ score) + actions — like Projects */}
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                <ShieldCheck size={20} className="text-teal-500" />
              </div>
              <TruncatedText text={localized(rs.name, language)} readOnly className="min-w-0 flex-1 text-sm font-medium" />
              {rs.lastScore != null && (
                <span className={cn('shrink-0 font-mono text-xs font-medium', scoreColor(rs.lastScore))}>
                  {rs.lastScore}%
                </span>
              )}
              <div className="ml-auto shrink-0">{actionsMenu}</div>
            </div>
            {/* Description — full-width line below */}
            <div className="mt-2 h-4">
              {localized(rs.description, language) && (
                <TruncatedText text={localized(rs.description, language)} className="text-xs text-muted-foreground" />
              )}
            </div>
            {/* Database — full-width line below */}
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Database size={12} className="shrink-0" />
              <span className="truncate">{getSourceName(rs.dataSourceId)}</span>
            </div>
            <BadgeStrip badges={rs.badges ?? []} className="mt-1.5 h-5" />
          </div>
        )
      }}
      renderCreateDialog={({ open, onOpenChange, onCreated }) => (
        <CreateDqRuleSetDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
      )}
      renderEditDialog={dqActions.renderEditDialog}
    />
    </>
  )
}
