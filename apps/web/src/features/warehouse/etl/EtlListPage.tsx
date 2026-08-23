import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Workflow, Database, ArrowRight } from 'lucide-react'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import { TruncatedText } from '@/components/ui/truncated-text'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { useEtlStore } from '@/stores/etl-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { localized, setLocalized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { attachTreeIds, parseImportZip, reconstructTreeFiles } from '@/lib/entity-io'
import { withEntityDocs } from '@/lib/entity-docs-pull'
import type { TreeImportNode } from '@/lib/entity-io'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import type { ImportGitRemote } from '@/components/ui/import-source-dialog'
import { ListPageTemplate } from '../ListPageTemplate'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { CreateEtlDialog } from './CreateEtlDialog'
import { useEtlActions } from './use-etl-actions'
import type { EtlFile, EtlPipeline } from '@/types'

export function EtlListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { atLeast } = useMyWorkspaceRole()
  const language = useAppStore((s) => s.language)
  const { etlPipelinesLoaded, loadEtlPipelines, etlPipelines } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const etlActions = useEtlActions()

  useEffect(() => {
    if (!etlPipelinesLoaded) loadEtlPipelines()
  }, [etlPipelinesLoaded, loadEtlPipelines])

  const pipelines = useMemo(
    () => (activeWorkspaceId ? etlPipelines.filter((p) => p.workspaceId === activeWorkspaceId) : []),
    [etlPipelines, activeWorkspaceId],
  )

  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const filteredPipelines = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const filtered = pipelines.filter((p) => {
      if (q && !`${localized(p.name, language)} ${localized(p.description, language)}`.toLowerCase().includes(q)) return false
      if (badgeFilter.length > 0) {
        const labels = new Set((p.badges ?? []).map((b) => localized(b.label, language)))
        if (!badgeFilter.some((l) => labels.has(l))) return false
      }
      return true
    })
    return applySort(filtered, sort, {
      name: (p) => localized(p.name, language),
      createdAt: (p) => p.createdAt,
      updatedAt: (p) => p.updatedAt,
    })
  }, [pipelines, searchQuery, badgeFilter, sort, language])

  // Distinct badges across the workspace's items, first-seen colour per label so the
  // filter options match the chips drawn on the cards.
  const allBadges = useMemo(() => {
    const byLabel = new Map<string, string>()
    for (const p of pipelines) for (const b of p.badges ?? []) {
      const label = localized(b.label, language)
      if (label && !byLabel.has(label)) byLabel.set(label, b.color)
    }
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, color]) => ({ label, color }))
  }, [pipelines, language])

  const filterGroups: FilterGroup[] = allBadges.length > 0 ? [{
    key: 'badges',
    label: t('common.badges'),
    selected: badgeFilter,
    onChange: setBadgeFilter,
    options: allBadges.map((b) => ({
      value: b.label,
      label: b.label,
      badgeClass: getBadgeClasses(b.color),
      badgeStyle: getBadgeStyle(b.color),
    })),
  }] : []

  // No id at all = the database was left unset (it is optional at creation), which
  // is not the same as an id that no longer resolves to a database.
  const getSourceName = (sourceId: string) =>
    !sourceId ? '—' : dataSources.find((ds) => ds.id === sourceId)?.name ?? t('etl.unknown_source')

  // --- Import ---
  const [conflict, setConflict] = useState<{ name: string; pending: EtlPipeline; pendingFiles: TreeImportNode[] } | null>(null)

  const doImport = useCallback(async (pipeline: EtlPipeline, files: TreeImportNode[], duplicate: boolean) => {
    const now = new Date().toISOString()
    const id = duplicate ? crypto.randomUUID() : pipeline.id
    // The cloned HEAD rides in on gitRemoteConfig.syncedOid but must not be
    // persisted — capture it for anchoring, then strip it from the stored config.
    const syncedOid = pipeline.gitRemoteConfig?.syncedOid
    const gitRemoteConfig = pipeline.gitRemoteConfig
      ? { url: pipeline.gitRemoteConfig.url, branch: pipeline.gitRemoteConfig.branch, authToken: pipeline.gitRemoteConfig.authToken }
      : pipeline.gitRemoteConfig
    const entity: EtlPipeline = {
      ...pipeline,
      gitRemoteConfig,
      id,
      workspaceId: activeWorkspaceId ?? pipeline.workspaceId,
      name: duplicate ? setLocalized(pipeline.name, language, `${localized(pipeline.name, language)} (copy)`) : pipeline.name,
      updatedAt: now,
      ...(duplicate ? { createdAt: now } : {}),
    }
    if (!duplicate) {
      // Overwrite: delete old children first. A fresh import (git clone of a
      // pipeline not on this server) has nothing to clear — the file delete 404s
      // ("Not found") on the missing pipeline, so swallow it like the row delete.
      await getStorage().etlFiles.deleteByPipeline(pipeline.id).catch(() => {})
      await getStorage().etlPipelines.delete(pipeline.id).catch(() => {})
    }
    await getStorage().etlPipelines.create(entity)
    // Anchor sync state to the commit we cloned (server-mode git import only): it's
    // the base this workspace imported from, so a later push elsewhere is detected
    // as "behind". Best-effort — a failure just means no banner yet.
    if (syncedOid) {
      try {
        const { gitSetSyncState } = await import('@/lib/api/git')
        await gitSetSyncState('etl-pipelines', id, gitRemoteConfig?.branch ?? 'main', syncedOid)
      } catch { /* leave unanchored — lazy adoption may still catch a clean sync */ }
    }
    // Ids are derived from (target pipeline id, path), so a duplicate — which gets
    // a fresh pipeline id — automatically gets a distinct, collision-free set.
    for (const f of attachTreeIds<EtlFile>(files, id, 'pipelineId')) {
      await getStorage().etlFiles.create(f)
    }
    await loadEtlPipelines()
  }, [activeWorkspaceId, language, loadEtlPipelines])

  const handleImport = useCallback(async (file: File, gitRemote?: ImportGitRemote) => {
    const parsed = await parseImportZip(file)
    // New git-friendly layout (_pipeline.json + _tree.json + raw files) with a fallback
    // to the legacy layout (pipeline.json + files.json).
    const pipeline = (parsed['_pipeline.json'] ?? parsed['pipeline.json']) as EtlPipeline | undefined
    if (!pipeline?.id) return
    // Imported from a git repo → pre-link the Versioning page to that repo (with
    // the token, if supplied). The export strips gitRemoteConfig, so it's only
    // ever set from the import source.
    if (gitRemote) pipeline.gitRemoteConfig = gitRemote
    withEntityDocs(pipeline, parsed)
    const files = reconstructTreeFiles(parsed['_tree.json'] ?? parsed['files.json'], parsed)
    const existing = await getStorage().etlPipelines.getById(pipeline.id)
    if (existing) {
      setConflict({ name: localized(existing.name, language), pending: pipeline, pendingFiles: files })
    } else {
      await doImport(pipeline, files, false)
    }
  }, [activeWorkspaceId, language, doImport])

  return (
    <>
    <ImportConflictDialog
      open={!!conflict}
      onOpenChange={(open) => { if (!open) setConflict(null) }}
      existingName={conflict?.name ?? ''}
      onDuplicate={() => { if (conflict) doImport(conflict.pending, conflict.pendingFiles, true); setConflict(null) }}
      onOverwrite={() => { if (conflict) doImport(conflict.pending, conflict.pendingFiles, false); setConflict(null) }}
    />
    <ListPageTemplate<EtlPipeline>
      canEdit={atLeast('editor')}
      canDelete={atLeast('owner')}
      titleKey="etl.title"
      descriptionKey="etl.description"
      newButtonKey="etl.new_pipeline"
      emptyTitleKey="etl.no_pipelines"
      emptyDescriptionKey="etl.no_pipelines_description"
      deleteConfirmTitleKey={etlActions.deleteConfirmTitleKey}
      deleteConfirmDescriptionKey={etlActions.deleteConfirmDescriptionKey}
      emptyIcon={Workflow}
      items={filteredPipelines}
      toolbar={
        pipelines.length > 0 ? (
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
      onDelete={etlActions.onDelete}
      onExport={etlActions.onExport}
      getGitRemote={etlActions.getGitRemote}
      docs={etlActions.docs}
      onSaveGitRemote={etlActions.onSaveGitRemote}
      exportSupportsIncludeData={etlActions.exportSupportsIncludeData}
      syncScope="etl-pipelines"
      onImport={handleImport}
      renderCardBody={(pipeline, actionsMenu) => {
        return (
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                <Workflow size={20} className="text-teal-500" />
              </div>
              <TruncatedText text={localized(pipeline.name, language)} readOnly className="min-w-0 flex-1 text-sm font-medium" />
              <div className="ml-auto shrink-0">{actionsMenu}</div>
            </div>
            <div className="mt-2 h-4">
              {localized(pipeline.description, language) && (
                <TruncatedText text={localized(pipeline.description, language)} readOnly className="text-xs text-muted-foreground" />
              )}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Database size={12} className="shrink-0" />
              <span className="truncate">{getSourceName(pipeline.sourceDataSourceId)}</span>
              {pipeline.targetDataSourceId && (
                <>
                  <ArrowRight size={10} className="shrink-0" />
                  <span className="truncate">{getSourceName(pipeline.targetDataSourceId)}</span>
                </>
              )}
            </div>
            <BadgeStrip badges={pipeline.badges ?? []} className="mt-1.5 h-5" />
          </div>
        )
      }}
      renderCreateDialog={({ open, onOpenChange, onCreated }) => (
        <CreateEtlDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
      )}
      renderEditDialog={etlActions.renderEditDialog}
    />
    </>
  )
}
