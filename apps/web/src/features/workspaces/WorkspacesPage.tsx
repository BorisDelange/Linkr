import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { paths, type SummaryTab } from '@/lib/paths'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useEtlStore } from '@/stores/etl-store'
import { useDqStore } from '@/stores/dq-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { isServerMode, formatApiError, type FormattedError } from '@/lib/api-client'
import { findLineageMatch, type ImportTarget } from '@/lib/import-identity'
import { importWorkspaceTree, type WorkspaceImportResult } from '@/lib/workspace-import'
import { Plus, Building2, Upload, MoreHorizontal, Download, Trash2, Loader2, GitBranch, Check, Pencil, Settings2, AlertCircle, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cardMenuTriggerClass, cn } from '@/lib/utils'
import { BulkDeleteAction } from '@/components/ui/bulk-delete-action'
import { useCardSelection, selectedCardClass } from '@/components/ui/use-card-selection'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { ImportErrorDialog } from '@/components/ui/import-error-dialog'
import { ImportSourceDialog, type ImportGitRemote } from '@/components/ui/import-source-dialog'
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'
import { EditWorkspaceDialog } from './EditWorkspaceDialog'
import { badgeFilterOptions } from '@/lib/badge-filter-options'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { ListPageToolbar, type FilterGroup } from '@/components/ui/list-page-toolbar'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { TruncatedText } from '@/components/ui/truncated-text'
import { applySort, visitSortFields } from '@/lib/list-sort'
import { usePersistedSort } from '@/lib/use-persisted-sort'
import { localized } from '@/lib/localized'
import { parseWorkspaceZip, collectGitLinkedEntities, applyClonedEntity } from '@/lib/entity-io'
import type { ParsedWorkspaceZip, GitLinkedEntity } from '@/lib/entity-io'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { gitCloneToZip } from '@/lib/api/git'
import { anchorClonedEntity } from '@/lib/git-clone-anchor'
import { getStorage } from '@/lib/storage'
import type { Workspace } from '@/types'

export function WorkspacesPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { workspaces, _workspacesRaw, openWorkspace, deleteWorkspace } = useWorkspaceStore()
  const { loadProjects } = useAppStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const [sort, setSort] = usePersistedSort('workspaces')

  const badgeCategories = useBadgeCategories()

  const allBadges = useMemo(() => {
    const byLabel = new Map<string, string>()
    for (const raw of _workspacesRaw) for (const b of raw.badges ?? []) {
      const label = localized(b.label, i18n.language)
      if (label && !byLabel.has(label)) byLabel.set(label, b.color)
    }
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, color]) => ({ label, color }))
  }, [_workspacesRaw, i18n.language])

  const filteredWorkspaces = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = workspaces.filter((ws) => {
      if (words.length) {
        const hay = `${ws.name} ${ws.organizationName ?? ''}`.toLowerCase()
        if (!words.every((w) => hay.includes(w))) return false
      }
      if (badgeFilter.length) {
        const labels = new Set((_workspacesRaw.find((w) => w.id === ws.id)?.badges ?? []).map((b) => localized(b.label, i18n.language)))
        if (!badgeFilter.some((l) => labels.has(l))) return false
      }
      return true
    })
    return applySort(filtered, sort, {
      name: (ws) => ws.name,
      createdAt: (ws) => ws.createdAt,
      updatedAt: (ws) => ws.updatedAt,
      entityType: 'workspace',
      id: (ws) => ws.id,
    })
  }, [workspaces, _workspacesRaw, searchQuery, badgeFilter, sort, i18n.language])

  const selection = useCardSelection(useMemo(() => filteredWorkspaces.map((w) => w.id), [filteredWorkspaces]))

  const filterGroups = useMemo<FilterGroup[]>(() => [
    {
      key: 'badges',
      label: t('common.badges'),
      options: badgeFilterOptions(allBadges, badgeCategories, i18n.language, t('badge_categories.no_category')),
      selected: badgeFilter,
      onChange: setBadgeFilter,
    },
  ], [t, badgeFilter, allBadges])

  // Open the create dialog straight away when arriving via "Create a workspace"
  // (?new=1 from the Home empty state), then clear the flag from the URL.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setDialogOpen(true)
      setSearchParams((prev) => { prev.delete('new'); return prev }, { replace: true })
    }
  }, [searchParams, setSearchParams])
  const [importOpen, setImportOpen] = useState(false)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)


  // Import conflict state
  // pending.workspace already carries gitRemoteConfig (baked in before the conflict
  // check), so runImport re-applies the git link on duplicate/overwrite too.
  const [importConflict, setImportConflict] = useState<{ name: string; pending: ParsedWorkspaceZip } | null>(null)
  const [importError, setImportError] = useState<FormattedError | null>(null)
  /** Non-fatal: the workspace imported, this only says what is missing from it. */
  const [importWarning, setImportWarning] = useState<FormattedError | null>(null)
  /** Held back while the git-linked summary is up, so the two dialogs don't stack. */
  const [pendingOrgWarning, setPendingOrgWarning] = useState<FormattedError | null>(null)
  /** Git-linked entities found in the last import (metadata only — content stays in their repos). */
  const [gitLinkedSummary, setGitLinkedSummary] = useState<GitLinkedEntity[] | null>(null)
  // Target workspace for a manual clone-retry from the summary dialog — without it
  // the retry would restore the entity into workspaceId '' (orphaned, invisible).
  const [gitLinkedWsId, setGitLinkedWsId] = useState<string | null>(null)
  const [cloneToken, setCloneToken] = useState('')
  const [cloneState, setCloneState] = useState<Record<string, 'pending' | 'done' | 'error'>>({})
  /** Why a clone failed, keyed like cloneState. The summary dialog shows it: a
   *  bare "retry" button leaves the user guessing whether the repo is
   *  unreachable, the token is missing, or the server rejected the content. */
  const [cloneError, setCloneError] = useState<Record<string, FormattedError>>({})

  /** Record (or clear) the git-linked content reconstitution status so the entity
   *  card can badge "not imported" + offer a retry. Best-effort. Server rows in
   *  server mode, localStorage in front-only (where cloning isn't possible — the
   *  badge then explains that instead of offering a retry). */
  const syncContentStatus = useCallback(async (
    e: GitLinkedEntity, workspaceId: string | undefined, status: 'pending' | 'failed' | null,
  ): Promise<void> => {
    const wsId = workspaceId ?? gitLinkedWsId
    if (!wsId) return
    const { contentScopeForLinkedType, gitSetContentStatus, gitClearContentStatus } = await import('@/lib/api/git')
    const scope = contentScopeForLinkedType[e.type]
    if (!scope) return
    if (!isServerMode()) {
      const { setLocalGitContentStatus } = await import('@/components/versioning/use-git-content-statuses')
      setLocalGitContentStatus(wsId, scope, e.id, status)
      return
    }
    try {
      if (status === null) await gitClearContentStatus(wsId, scope, e.id)
      else await gitSetContentStatus(wsId, scope, e.id, status)
    } catch { /* status is advisory — never block the import/clone on it */ }
  }, [gitLinkedWsId])

  /**
   * The stored row a clone must write into, found by lineage.
   *
   * The single source of truth for "which row is this entity?" is the one the
   * import used (`findLineageMatch`), asked here against what it actually
   * wrote. Returns null when the manifest carries no lineage or nothing
   * matches, and the caller falls back to the id map.
   *
   * `project` is absent on purpose: projects are keyed by `uid`, not by a
   * lineage-bearing row, and their id already survives the round trip.
   */
  const resolveClonedEntityId = useCallback(async (
    e: GitLinkedEntity,
    targetWsId: string,
    duplicate: boolean,
  ): Promise<string | null> => {
    // A duplicate copies the lineage but is a NEW row, so matching on it would
    // resolve to the entity being copied and the clone would overwrite the
    // original. The import mints fresh ids there; only idMap knows them.
    if (duplicate || !e.lineageId) return null
    const storage = getStorage()
    const rowsFor: Partial<Record<GitLinkedEntity['type'], () => Promise<ImportTarget[]>>> = {
      'mapping-project': () => storage.mappingProjects.getAll(),
      'sql-collection': () => storage.sqlScriptCollections.getAll(),
      'etl-pipeline': () => storage.etlPipelines.getAll(),
      'data-catalog': () => storage.dataCatalogs.getAll(),
      'dq-rule-set': () => storage.dqRuleSets.getAll(),
      'schema-preset': () => storage.schemaPresets.getAll() as Promise<ImportTarget[]>,
      'database': () => storage.dataSources.getAll(),
    }
    const load = rowsFor[e.type]
    if (!load) return null
    try {
      return findLineageMatch(await load(), { lineageId: e.lineageId }, targetWsId)?.id ?? null
    } catch {
      return null
    }
  }, [])

  /** Clone a git-linked entity server-side and load its full content under its
   *  imported record. `token`/`workspaceId` override the component state so the
   *  auto-clone loop (which runs before React commits the token input) can pass
   *  them explicitly. */
  const cloneEntityContent = useCallback(async (
    e: GitLinkedEntity,
    opts: { token?: string; workspaceId?: string } = {},
  ): Promise<boolean> => {
    const key = `${e.type}-${e.id}`
    setCloneState(s => ({ ...s, [key]: 'pending' }))
    setCloneError(s => { const { [key]: _drop, ...rest } = s; return rest })
    try {
      // Server-side clone only: the backend clones the repo; load its ZIP bytes
      // into JSZip so applyClonedEntity reads it as before.
      const JSZip = (await import('jszip')).default
      const cloned = await gitCloneToZip(e.url, e.branch, opts.token ?? cloneToken ?? undefined)
      const zip = await JSZip.loadAsync(cloned.blob)
      // Keep the git link on the restored entity (the repo's project.json strips it).
      // Only url+branch are stored — the token is persisted separately, encrypted.
      const gitRemote = { url: e.url, branch: e.branch }
      const ok = await applyClonedEntity(zip, e.type, e.id, getStorage(), opts.workspaceId, gitRemote)
      // Anchor sync state to the cloned commit so a later remote push is detected
      // as "behind" — mirrors the standalone import and the catalog install. Every
      // linked type, not just mapping projects: a workspace-imported project used
      // to land unanchored, and its Versioning page then never offered a pull.
      if (ok && isServerMode()) await anchorClonedEntity(e.type, e.id, e.branch, cloned.oid)
      // Content reconstitution status: clear it on success (card badge disappears),
      // mark 'failed' otherwise so the card shows a retry affordance.
      await syncContentStatus(e, opts.workspaceId, ok ? null : 'failed')
      setCloneState(s => ({ ...s, [key]: ok ? 'done' : 'error' }))
      if (!ok) {
        setCloneError(s => ({
          ...s,
          [key]: { summaryKey: 'workspaces.import_git_clone_no_content', detail: null },
        }))
      }
      return ok
    } catch (err) {
      await syncContentStatus(e, opts.workspaceId, 'failed')
      setCloneState(s => ({ ...s, [key]: 'error' }))
      setCloneError(s => ({ ...s, [key]: formatApiError(err) }))
      return false
    }
  }, [cloneToken, syncContentStatus])

  const handleCloneEntity = useCallback(
    (e: GitLinkedEntity) => cloneEntityContent(e, { workspaceId: gitLinkedWsId ?? undefined }),
    [cloneEntityContent, gitLinkedWsId],
  )

  /** Progress line while auto-cloning git-linked entities after a workspace import. */
  const reportCloneProgress = useCallback((done: number, total: number, name: string) => {
    setImportProgress({ phaseKey: 'workspaces.import_phase_clone_linked', done, total, name })
  }, [])

  // Import progress state — modal shown while doImport is running.
  // `phaseKey` is an i18n key under workspaces.import_phase_*.
  // `done`/`total` count items inside the current phase (e.g. mappings imported / total).
  interface ImportProgress {
    phaseKey: string
    done?: number
    total?: number
    /** Name of the item currently being processed (e.g. the git-linked entity being cloned). */
    name?: string
  }
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)

  // Delete progress state — modal shown while a workspace is being cascaded.
  const [deleteProgress, setDeleteProgress] = useState<{ phaseKey: string } | null>(null)

  const handleOpenWorkspace = (id: string, name: string, tab?: SummaryTab) => {
    openWorkspace(id, name)
    navigate(paths.workspaceHome(id, tab))
  }

  // Deleting a workspace is long enough to need its own progress modal, so both
  // the single and the bulk path go through here.
  const runDelete = async (ids: string[]) => {
    setDeleteProgress({ phaseKey: 'workspaces.delete_phase_projects' })
    try {
      for (const id of ids) {
        await deleteWorkspace(id, (phaseKey) => setDeleteProgress({ phaseKey }))
      }
    } finally {
      setDeleteProgress(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    // Hide the confirmation dialog right away, then show the progress modal.
    setDeleteTarget(null)
    await runDelete([target.id])
  }

  // --- Import logic ---
  const doImport = useCallback(
    (parsed: ParsedWorkspaceZip, duplicate: boolean): Promise<WorkspaceImportResult> =>
      importWorkspaceTree(parsed, {
        duplicate,
        onPhase: (phaseKey, done, total) => setImportProgress({ phaseKey, done, total }),
        language: i18n.language,
      }),
    [i18n.language],
  )

  /** Run an import while showing the progress modal and clearing it afterwards. */
  const runImport = useCallback(async (parsed: ParsedWorkspaceZip, duplicate: boolean) => {
    setImportProgress({ phaseKey: 'workspaces.import_phase_workspace' })
    try {
      const { targetWsId, idMap, skippedOrgName } = await doImport(parsed, duplicate)
      let gitLinkedShown = false
      // Git-linked entities carry only metadata in the workspace ZIP — their full
      // content lives in their repos. Auto-clone each and load it now (server mode),
      // so the entity arrives complete instead of empty. Best-effort per item; a
      // repo that needs a token (or fails) drops to the summary dialog for a manual
      // retry.
      //
      // Each clone must be pointed at the row the import actually wrote. Lineage
      // answers that the way the import itself decided it (resolveByLineage), by
      // reading back the stored rows — so the two agree by construction rather
      // than by two call sites happening to build the same lookup key. idMap
      // remains the fallback for an entity whose manifest carries no lineage.
      const linked = await Promise.all(
        collectGitLinkedEntities(parsed).map(async (e) => ({
          ...e,
          id: (await resolveClonedEntityId(e, targetWsId, duplicate)) ?? idMap.get(`${e.type}:${e.id}`) ?? e.id,
        })),
      )
      if (linked.length > 0) {
        const token = parsed.workspace.gitRemoteConfig?.authToken
        let anyFailed = false
        if (isServerMode()) {
          // Mark every linked entity 'pending' up front so a clone that never runs
          // (or dies mid-loop) still leaves the card badged; each clone then clears
          // it on success or flips it to 'failed'.
          for (const e of linked) await syncContentStatus(e, targetWsId, 'pending')
          for (let i = 0; i < linked.length; i++) {
            reportCloneProgress(i, linked.length, linked[i].name)
            const ok = await cloneEntityContent(linked[i], { token, workspaceId: targetWsId })
            if (!ok) anyFailed = true
          }
          // The clones wrote content AFTER doImport's store invalidation, so drop the
          // per-page loaded flags again to force a reload with the now-populated
          // children. catalogsLoaded feeds the global App-shell gate, so reload it
          // (flag back to true) rather than leaving it false and blanking the app.
          useSqlScriptsStore.setState({ collectionsLoaded: false })
          useEtlStore.setState({ etlPipelinesLoaded: false })
          useDqStore.setState({ dqRuleSetsLoaded: false })
          useConceptMappingStore.setState({ mappingProjectsLoaded: false })
          // A git-linked project's own metadata (README, tasks, git pointer) is written
          // by the clone's projects.update, AFTER doImport's loadProjects ran — so the
          // app store still holds the empty-README pointer row. Reload it, else the
          // project's Summary shows a blank README/tasks until a full page reload.
          await loadProjects()
          // The databases too: a git-linked database's own clone rewrites its row
          // (schema mapping included) after doImport loaded the store. Every
          // "choose a database" picker reads it and intersects with the project's
          // links, so a stale store left a cohort's dropdown empty until a manual
          // page reload — even though both sides were correct in storage.
          await useDataSourceStore.getState().loadDataSources(true)
          // Cohorts and pipelines load once, at app startup, so an imported
          // project's cohorts stayed invisible until a manual page reload.
          await useCohortStore.getState().loadCohorts()
          await usePipelineStore.getState().loadPipelines()
          await useCatalogStore.getState().loadCatalogs()
        } else {
          // Client-only: cloning is impossible — badge every linked entity so its
          // card explains the content wasn't downloaded (and why), like the
          // failed-clone badge in server mode.
          for (const e of linked) await syncContentStatus(e, targetWsId, 'failed')
          anyFailed = true
        }
        setImportProgress(null)
        // Show the dialog only when something still needs the user (a failed/pending
        // auto-clone, or client-only where auto-clone can't run).
        if (anyFailed) { setGitLinkedWsId(targetWsId); setGitLinkedSummary(linked) }
        gitLinkedShown = anyFailed
      }
      // Both are AlertDialogs and would stack, so the git-linked summary — which the
      // user must act on — wins; the org notice waits for it to close.
      if (skippedOrgName) {
        const notice = { summary: t('workspaces.import_org_skipped_body', { name: skippedOrgName }), detail: null }
        if (gitLinkedShown) setPendingOrgWarning(notice)
        else setImportWarning(notice)
      }
    } catch (err) {
      setImportError(formatApiError(err))
    } finally {
      setImportProgress(null)
    }
  }, [doImport, cloneEntityContent]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Import a workspace from an uploaded ZIP or a git clone (via ImportSourceDialog).
   *  `gitRemote` is set when cloned from git → pre-link the workspace's Versioning
   *  page to that repo (workspace.json export strips gitRemoteConfig, so it's only
   *  ever set here). */
  const handleImportSource = useCallback(async (file: File, gitRemote?: ImportGitRemote) => {
    try {
      // Show the modal immediately while we parse the ZIP — that step alone can take a while
      // for large workspaces.
      setImportProgress({ phaseKey: 'workspaces.import_phase_parsing' })
      const parsed = await parseWorkspaceZip(file)
      if (!parsed) {
        setImportProgress(null)
        setImportError({ summary: t('workspaces.import_invalid_zip'), detail: null })
        return
      }
      if (gitRemote) parsed.workspace.gitRemoteConfig = gitRemote

      const existingWs = await getStorage().workspaces.getById(parsed.workspace.id)
      if (existingWs) {
        // Conflict: hide the progress modal, show the conflict dialog instead.
        setImportProgress(null)
        const name = typeof existingWs.name === 'string' ? existingWs.name : (existingWs.name.en || Object.values(existingWs.name)[0] || '')
        setImportConflict({ name, pending: parsed })
      } else {
        await runImport(parsed, false)
      }
    } catch (err) {
      setImportProgress(null)
      setImportError(formatApiError(err))
    }
  }, [runImport, t])

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">
            {t('workspaces.title')}
          </h1>
          <div className="flex items-center gap-1">
            {selection.active ? (
              <BulkDeleteAction
                selection={selection}
                names={(id) => filteredWorkspaces.find((w) => w.id === id)?.name ?? id}
                onDeleteMany={runDelete}
              />
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1 text-xs"
                  onClick={() => setImportOpen(true)}
                >
                  <Upload size={14} />
                  {t('common.import')}
                </Button>
                <Button size="sm" onClick={() => setDialogOpen(true)} className="gap-1 text-xs">
                  <Plus size={14} />
                  {t('workspaces.create')}
                </Button>
              </>
            )}
          </div>
        </div>

        {workspaces.length > 0 && (
          <ListPageToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('workspaces.search_placeholder')}
            filterGroups={filterGroups}
            sort={{ options: visitSortFields(t), value: sort, onChange: setSort }}
          />
        )}

        {workspaces.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <Building2 size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('workspaces.no_workspaces')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('workspaces.no_workspaces_description')}
              </p>
            </div>
          </Card>
        ) : filteredWorkspaces.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <Building2 size={40} className="text-muted-foreground/30" />
              <p className="mt-4 text-sm font-medium text-foreground">{t('common.no_results')}</p>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {filteredWorkspaces.map((ws) => {
              const raw = _workspacesRaw.find((w) => w.id === ws.id)
              const badges = raw?.badges ?? []
              return (
                <Card
                  key={ws.id}
                  className={cn(
                    'flex min-h-44 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent',
                    selection.isSelected(ws.id) && selectedCardClass,
                  )}
                  onClick={(e) => {
                    if (selection.onCardClick(e, ws.id)) return
                    handleOpenWorkspace(ws.id, ws.name)
                  }}
                >
                  <div className="flex flex-1 flex-col px-4 pt-5">
                   <div className="flex flex-1 flex-col justify-center">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
                          <Building2 size={20} className="text-amber-500" />
                        </div>
                        <div className="min-w-0">
                          <span className="block truncate text-sm font-medium text-card-foreground">
                            {ws.name}
                          </span>
                          {ws.organizationName && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {ws.organizationName}
                            </span>
                          )}
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" className={cardMenuTriggerClass} onClick={(e) => e.stopPropagation()}>
                            <MoreHorizontal size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); if (raw) setEditingWorkspace(raw) }}>
                            <Pencil size={14} />
                            {t('common.edit')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); navigate(paths.workspaceVersioning(ws.id, 'export')) }}>
                            <Download size={14} />
                            {t('common.export')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); navigate(paths.workspaceVersioning(ws.id, 'git')) }}>
                            <GitBranch size={14} />
                            {t('common.versioning')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); navigate(paths.workspaceSettings(ws.id)) }}>
                            <Settings2 size={14} />
                            {t('nav.settings')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: ws.id, name: ws.name }) }}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 size={14} className="text-destructive" />
                            {t('common.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="mt-2 h-4">
                      {ws.description && (
                        <TruncatedText text={ws.description} readOnly className="text-xs text-muted-foreground" />
                      )}
                    </div>
                    <BadgeStrip badges={badges} className="mt-1.5 h-5" />
                   </div>
                    <CardMetaFooter
                      createdById={raw?.createdById}
                      createdBy={raw?.createdBy}
                      createdByDetails={raw?.createdByDetails}
                      organizationId={raw?.organizationId}
                      organization={raw?.organization}
                      createdAt={ws.createdAt}
                      updatedAt={ws.updatedAt}
                      license={raw?.license}
                      onOpenLicense={() => {
                        openWorkspace(ws.id, ws.name)
                        navigate(`${paths.workspaceHome(ws.id)}?tab=license`)
                      }}
                    />
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <CreateWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} onCreated={handleOpenWorkspace} />

      <EditWorkspaceDialog
        open={!!editingWorkspace}
        workspace={editingWorkspace ?? undefined}
        onOpenChange={(open) => { if (!open) setEditingWorkspace(null) }}
      />

      {/* Import a workspace from a ZIP or a git clone */}
      <ImportSourceDialog open={importOpen} onOpenChange={setImportOpen} accept=".zip" onImport={handleImportSource} scope="workspaces" />

      {/* Import conflict dialog */}
      <ImportConflictDialog
        open={!!importConflict}
        onOpenChange={(open) => { if (!open) setImportConflict(null) }}
        existingName={importConflict?.name ?? ''}
        onDuplicate={() => { if (importConflict) runImport(importConflict.pending, true); setImportConflict(null) }}
        onOverwrite={() => { if (importConflict) runImport(importConflict.pending, false); setImportConflict(null) }}
      />

      {/* Delete workspace confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('workspaces.delete_workspace')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspaces.delete_workspace_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleDelete}
            >
              {t('workspaces.delete_workspace')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import progress modal — non-dismissable while doImport runs.
          Close button hidden, Escape & click-outside disabled. */}
      <Dialog open={!!importProgress} onOpenChange={() => { /* not dismissable */ }}>
        <DialogContent
          className="max-w-md"
          showCloseButton={false}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-primary" />
              {t('workspaces.import_progress_title')}
            </DialogTitle>
          </DialogHeader>
          {importProgress && (
            <div className="space-y-3 pt-2">
              <p className="text-xs text-muted-foreground">{t(importProgress.phaseKey)}</p>
              {importProgress.name && (
                <p className="truncate text-[11px] font-medium text-foreground">{importProgress.name}</p>
              )}
              {typeof importProgress.total === 'number' && importProgress.total > 0 && (
                <>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${Math.min(100, Math.round(((importProgress.done ?? 0) / importProgress.total) * 100))}%` }}
                    />
                  </div>
                  <p className="text-[10px] tabular-nums text-muted-foreground">
                    {(importProgress.done ?? 0).toLocaleString()} / {importProgress.total.toLocaleString()}
                  </p>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete progress modal — non-dismissable while deleteWorkspace runs. */}
      <Dialog open={!!deleteProgress} onOpenChange={() => { /* not dismissable */ }}>
        <DialogContent
          className="max-w-md"
          showCloseButton={false}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-primary" />
              {t('workspaces.delete_progress_title')}
            </DialogTitle>
          </DialogHeader>
          {deleteProgress && (
            <div className="pt-2">
              <p className="text-xs text-muted-foreground">{t(deleteProgress.phaseKey)}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Import error dialog */}
      <ImportErrorDialog error={importError} onClose={() => setImportError(null)} />
      <ImportErrorDialog
        error={importWarning}
        onClose={() => setImportWarning(null)}
        title={t('workspaces.import_org_skipped_title')}
        variant="warning"
      />

      {/* Git-linked entities summary after import (metadata only — content lives in their repos) */}
      <AlertDialog
        open={gitLinkedSummary !== null}
        onOpenChange={(open) => {
          if (open) return
          setGitLinkedSummary(null)
          setGitLinkedWsId(null)
          if (pendingOrgWarning) { setImportWarning(pendingOrgWarning); setPendingOrgWarning(null) }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <GitBranch size={18} className="text-violet-500" />
              {t('workspaces.import_git_linked_title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspaces.import_git_linked_body', { count: gitLinkedSummary?.length ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Clone the linked entities — server-side only. In client-only mode we
              still list the linked entities below, but cloning their content needs
              the backend (the in-browser CORS-proxy clone was dropped). */}
          {isServerMode() ? (
            <div className="space-y-2 rounded-md border border-border p-3">
              <Input
                type="password"
                value={cloneToken}
                onChange={(e) => setCloneToken(e.target.value)}
                placeholder={t('workspaces.import_git_token_optional')}
                className="h-8 text-xs"
              />
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                {t('workspaces.import_git_server_hint')}
              </p>
            </div>
          ) : (
            <ServerModeNotice inline />
          )}

          <div className="max-h-48 overflow-auto rounded-md border border-border">
            {(gitLinkedSummary ?? []).map((e) => {
              const key = `${e.type}-${e.id}`
              const st = cloneState[key]
              const err = cloneError[key]
              return (
                <div key={key} className="flex items-center justify-between gap-2 px-3 py-2 text-xs border-b border-border last:border-0">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{e.name}</div>
                    <div className="truncate text-[10px] text-muted-foreground">{e.url}</div>
                    {st === 'error' && err && (
                      <div className="mt-1 flex items-center gap-1.5 rounded-md border border-destructive/50 bg-destructive/5 px-1.5 py-1 text-[10px] text-destructive">
                        <AlertCircle size={11} className="shrink-0" />
                        <span className="truncate">
                          {err.summaryKey
                            ? t(err.summaryKey, { count: err.summaryCount ?? 0 })
                            : err.summary}
                        </span>
                        {err.detail && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Info size={11} className="shrink-0 cursor-help" />
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="max-w-sm">
                                <pre className="whitespace-pre-wrap break-words text-[10px]">{err.detail}</pre>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </div>
                    )}
                  </div>
                  {isServerMode() && (
                    <Button
                      size="sm-tight" variant="outline"
                      className="shrink-0 text-[11px]"
                      disabled={st === 'pending' || st === 'done'}
                      onClick={() => handleCloneEntity(e)}
                    >
                      {st === 'pending' ? <Loader2 size={12} className="animate-spin" />
                        : st === 'done' ? <Check size={12} className="text-primary" />
                        : <Download size={12} />}
                      {st === 'done' ? t('workspaces.import_git_cloned')
                        : st === 'error' ? t('workspaces.import_git_clone_retry')
                        : t('workspaces.import_git_clone')}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => { setGitLinkedSummary(null); setGitLinkedWsId(null); setCloneState({}); setCloneError({}) }}>
              {t('common.ok')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
