import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { paths, type SummaryTab } from '@/lib/paths'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useAppStore } from '@/stores/app-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useFileStore } from '@/stores/file-store'
import { useWikiStore } from '@/stores/wiki-store'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useEtlStore } from '@/stores/etl-store'
import { useDqStore } from '@/stores/dq-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { isServerMode, formatApiError, type FormattedError } from '@/lib/api-client'
import {
  resolveByLineage as resolveByLineageRule,
  resolveChildId as resolveChildIdRule,
  resolveWorkspaceId,
  findLineageMatch,
  type ImportTarget,
} from '@/lib/import-identity'
import { Plus, Building2, Upload, MoreHorizontal, Download, Trash2, Loader2, GitBranch, Check, Pencil, Settings2, AlertCircle, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cardMenuTriggerClass, cn } from '@/lib/utils'
import { BulkDeleteAction } from '@/components/ui/bulk-delete-action'
import { useCardSelection, selectedCardClass } from '@/components/ui/use-card-selection'
import { Card } from '@/components/ui/card'
import { mintEntityId } from '@/components/ui/entity-id-field'
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
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { TruncatedText } from '@/components/ui/truncated-text'
import { applySort, visitSortFields } from '@/lib/list-sort'
import { localized } from '@/lib/localized'
import { parseWorkspaceZip, deleteProjectData, collectGitLinkedEntities, applyClonedEntity, importProjectContent, createEntityAttachments, projectSlug, reassemblePresetMapping } from '@/lib/entity-io'
import type { ParsedWorkspaceZip, GitLinkedEntity } from '@/lib/entity-io'
import { rederiveTreeIds } from '@/lib/entity-tree'
import { seedBuiltinPluginsForWorkspace } from '@/lib/plugins/default-plugins'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { gitCloneToZip } from '@/lib/api/git'
import { getStorage } from '@/lib/storage'
import type { Project, WikiAttachment, LocalizedString, Workspace } from '@/types'

/** Append " (copy)" to every language of a multilingual name when duplicating. */
function copyLocalizedName(name: LocalizedString): LocalizedString {
  return Object.fromEntries(Object.entries(name ?? {}).map(([k, v]) => [k, `${v} (copy)`]))
}

export function WorkspacesPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { workspaces, _workspacesRaw, openWorkspace, deleteWorkspace } = useWorkspaceStore()
  const { loadProjects } = useAppStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const [sort, setSort] = useState<SortState | null>(null)

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
    const { scopeForLinkedType, gitSetContentStatus, gitClearContentStatus } = await import('@/lib/api/git')
    const scope = scopeForLinkedType[e.type]
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
      // Anchor sync state to the cloned commit (mapping projects, server mode) so
      // a later remote push is detected as "behind" — mirrors the standalone import.
      if (ok && e.type === 'mapping-project' && cloned.oid && isServerMode()) {
        try {
          const { gitSetSyncState } = await import('@/lib/api/git')
          await gitSetSyncState('mapping-projects', e.id, e.branch, cloned.oid)
        } catch { /* leave unanchored */ }
      }
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
  const doImport = useCallback(async (parsed: ParsedWorkspaceZip, duplicate: boolean): Promise<{ targetWsId: string; idMap: Map<string, string>; skippedOrgName: string | null }> => {
    const storage = getStorage()
    const now = new Date().toISOString()
    const { appVersion: _av, ...wsMeta } = parsed.workspace
    /** Set when the linked organization could not be created (see the org block below). */
    let skippedOrgName: string | null = null
    // `organizationId` is stripped as an instance field, so the manifest carries
    // the org only as an inline snapshot — whose `id` IS the cross-instance UUID
    // (an org's UUID is stable; it is what the catalog indexes). Without putting
    // it back the FK stayed null and an imported workspace read "no organization"
    // even when its org had just been imported from the same content repo.
    // The workspace's own inline snapshot first — organization.json is the same
    // record, but the inline one is what this workspace was exported pointing at.
    const orgIdFromSnapshot =
      wsMeta.organizationId
      ?? (wsMeta.organization as { id?: string } | null | undefined)?.id
      ?? parsed.organization?.id
    if (orgIdFromSnapshot) wsMeta.organizationId = orgIdFromSnapshot
    // The manifest no longer carries the writing instance's `id` (parseWorkspaceZip
    // mints one), so a re-import is recognised by `lineageId` — the cross-instance
    // identity. Matching on the minted id would never hit, turning every re-import
    // into a duplicate instead of an update.
    const targetWsId = resolveWorkspaceId(
      duplicate ? [] : await storage.workspaces.getAll().catch(() => []),
      wsMeta,
      duplicate,
    ).id
    // On a duplicate, every git-linked child is re-minted with a fresh uuid; the
    // post-import auto-clone must target those NEW ids, not the ZIP's original ones.
    // Keyed `${type}:${originalId}` → new id (see GitLinkedEntity.type vocabulary).
    const idMap = new Map<string, string>()

    // Resolve the id a workspace-level child (SQL collection, ETL pipeline, DQ
    // rule set, mapping project, catalog, …) should land under. A duplicate always
    // gets a fresh uuid. A plain import keeps the ZIP id (so a git round-trip
    // overwrites in place) — EXCEPT when that id already belongs to a child in
    // ANOTHER workspace: the delete-then-create below would then move that other
    // workspace's entity into this one (silent cross-workspace clobber), so mint a
    // fresh id instead. Mirrors the uid guard in ProjectsPage.doImport.
    const resolveChildId = async (
      getById: (id: string) => Promise<{ workspaceId?: string } | undefined>,
      originalId: string,
    ): Promise<string> =>
      resolveChildIdRule(
        duplicate ? undefined : await getById(originalId).catch(() => undefined),
        originalId,
        targetWsId,
        duplicate,
      )

    /**
     * Where a lineage-bearing child should land. The rule itself lives in
     * lib/import-identity.ts (and is tested there); this only feeds it the rows.
     */
    const resolveByLineage = async (
      list: () => Promise<{ id: string; lineageId?: string; workspaceId?: string }[]>,
      child: { id?: string; lineageId?: string },
    ): Promise<{ id: string; replaces: string | null }> =>
      resolveByLineageRule(
        duplicate || !child.lineageId ? [] : await list().catch(() => []),
        child,
        targetWsId,
        duplicate,
      )

    /** Report a phase to the progress modal. Called between blocks of work. */
    const reportPhase = (phaseKey: string, done?: number, total?: number) => {
      setImportProgress({ phaseKey, done, total })
    }
    /** Yield to the browser so React paints the new progress before the next sync block. */
    const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

    reportPhase('workspaces.import_phase_workspace')
    await yieldToBrowser()

    // Reconstitute the linked organization first so the workspace's
    // organizationId FK resolves. Upsert by UUID: an org already present on this
    // instance (or shared by a sibling workspace / a duplicate) is left as-is;
    // only a genuinely new org is created. Duplicating keeps the same org link.
    // organization.json normally carries it; a tree that only has the manifest's
    // inline snapshot still gets a row, so the FK set above never dangles.
    // Best-effort: `organizations:write` is a separate global permission from
    // `workspaces:write`, so a user allowed to import may still be refused the org
    // (403). The org is provenance metadata — losing it must not cost the user the
    // whole import — but a dangling FK would render as a phantom organization, so
    // drop the link too and report it rather than failing silently.
    const orgRecord = parsed.organization?.id
      ? parsed.organization
      : (wsMeta.organization as typeof parsed.organization | null | undefined)
    if (orgRecord?.id) {
      const existingOrg = await storage.organizations.getById(orgRecord.id).catch(() => undefined)
      // Export strips instance fields (createdAt/updatedAt); re-stamp on import so
      // consumers (and the server's NOT-NULL columns) get a valid record.
      if (!existingOrg) {
        try {
          await storage.organizations.create({
            ...orgRecord,
            createdAt: orgRecord.createdAt ?? now,
            updatedAt: now,
          })
        } catch {
          delete (wsMeta as Partial<Workspace>).organizationId
          skippedOrgName = localized(orgRecord.name, i18n.language) || orgRecord.id
        }
      }
    }

    // A duplicate is a fork: it must NOT inherit the source's git link, or a
    // later sync would push over the original repo. A plain import keeps the
    // link set from the import source (workspace.json never carries it — export
    // strips gitRemoteConfig — so it's only ever the clone's remote).
    if (duplicate) delete (wsMeta as Partial<Workspace>).gitRemoteConfig

    // Create workspace if it doesn't exist yet, or update if overwriting
    const existingWs = await storage.workspaces.getById(targetWsId)
    if (existingWs && !duplicate) {
      await storage.workspaces.update(targetWsId, { ...wsMeta, updatedAt: now })
    } else {
      await storage.workspaces.create({
        ...wsMeta,
        id: targetWsId,
        // Imported: keep the author snapshot, drop the foreign local id — the
        // backend re-resolves createdById by ORCID/email (see doImport in
        // ProjectsPage for the full rationale).
        createdById: undefined,
        name: duplicate
          ? (typeof wsMeta.name === 'string'
            ? `${wsMeta.name} (copy)` as unknown as typeof wsMeta.name
            : Object.fromEntries(Object.entries(wsMeta.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as typeof wsMeta.name)
          : wsMeta.name,
        updatedAt: now,
        // Export strips instance fields (createdAt/updatedAt); re-stamp on import
        // so consumers that split() createdAt don't crash. Duplicate = fresh date.
        createdAt: duplicate ? now : (wsMeta.createdAt ?? now),
        // Fork on duplicate (new lineage + parent), keep lineage on plain import.
        ...(duplicate
          ? { lineageId: crypto.randomUUID(), parentLineageId: wsMeta.lineageId }
          : { lineageId: wsMeta.lineageId ?? crypto.randomUUID() }),
      })
    }

    // --- Import projects ---
    if (parsed.projects.size > 0) {
      reportPhase('workspaces.import_phase_projects', 0, parsed.projects.size)
      await yieldToBrowser()
    }
    let projectIdx = 0
    for (const [, parsedProject] of parsed.projects) {
      const { project } = parsedProject
      if (!project?.uid) continue

      const uid = duplicate ? crypto.randomUUID() : project.uid
      const entity: Project = {
        ...project,
        uid,
        // A git-linked pointer project.json carries no description.
        description: project.description ?? {},
        createdById: undefined,
        ...(() => {
          const slug = projectSlug(project)
          const next = duplicate ? (slug ? `${slug}-copy` : undefined) : slug
          return { entityId: next, projectId: next }
        })(),
        workspaceId: targetWsId,
        name: duplicate
          ? (typeof project.name === 'string'
            ? `${project.name} (copy)` as unknown as Project['name']
            : Object.fromEntries(Object.entries(project.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as Project['name'])
          : project.name,
        updatedAt: now,
        // Export strips instance fields (createdAt/updatedAt); re-stamp on import
        // so consumers that split() createdAt don't crash. Duplicate = fresh date.
        createdAt: duplicate ? now : (project.createdAt ?? now),
        // Fork on duplicate (new lineage + parent), keep lineage on plain import.
        ...(duplicate
          ? { lineageId: crypto.randomUUID(), parentLineageId: project.lineageId }
          : { lineageId: project.lineageId ?? crypto.randomUUID() }),
      }

      // Clean up existing data
      await deleteProjectData(storage, uid)
      await storage.projects.delete(uid).catch(() => {})

      await storage.projects.create(entity)

      // Write all sub-entities (child ids remapped to fresh UUIDs to avoid collisions).
      await importProjectContent(parsedProject, uid, storage)
      projectIdx++
      reportPhase('workspaces.import_phase_projects', projectIdx, parsed.projects.size)
      await yieldToBrowser()
    }

    // --- Import lightweight project entries (catalog-only) ---
    if (parsed.projectEntries.length > 0) {
      reportPhase('workspaces.import_phase_project_entries', 0, parsed.projectEntries.length)
      await yieldToBrowser()
    }
    for (const entry of parsed.projectEntries) {
      const { project } = entry
      if (!project?.uid) continue
      const uid = duplicate ? crypto.randomUUID() : project.uid
      idMap.set(`project:${project.uid}`, uid)
      const existing = await storage.projects.getById(uid)
      if (existing && !duplicate) {
        // Update metadata + readme only
        await storage.projects.update(uid, {
          ...project, uid, workspaceId: targetWsId, readme: entry.readme ?? existing.readme, updatedAt: now,
        })
      } else {
        await storage.projects.create({
          ...project, uid, workspaceId: targetWsId,
          description: project.description ?? {},
          name: duplicate
            ? (typeof project.name === 'string'
              ? `${project.name} (copy)` as unknown as Project['name']
              : Object.fromEntries(Object.entries(project.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as Project['name'])
            : project.name,
          readme: entry.readme ?? {},
          updatedAt: now,
          ...(duplicate ? { createdAt: now } : {}),
        })
      }
    }

    // --- Import schema presets ---
    if (parsed.schemas.length > 0) {
      reportPhase('workspaces.import_phase_schemas', 0, parsed.schemas.length)
      await yieldToBrowser()
    }
    for (const sp of parsed.schemas) {
      // mintEntityId, not randomUUID: a preset's id IS its user-facing
      // Identifier — it fills that field and the URL carries it — so a raw uuid
      // put a 36-character string in front of the user (same reason the catalog
      // install mints one, see freshId in lib/catalog/install.ts).
      // `entityId` is the slug a preset is addressed by; `presetId` is the retired
      // name for it and is optional, so it cannot stand alone here.
      const sourceSlug = sp.entityId ?? sp.presetId ?? sp.id
      const presetId = duplicate ? mintEntityId() : sourceSlug
      // The row's PK is `id` (minted below), not the slug — and that is what a
      // later clone must address, since save() puts to /schema-presets/{id}.
      const localId = duplicate ? crypto.randomUUID() : (sp.id ?? crypto.randomUUID())
      idMap.set(`schema-preset:${sourceSlug}`, localId)
      if (!duplicate) await storage.schemaPresets.delete(sourceSlug).catch(() => {})
      // `mapping.presetId` follows the entity id: a ZIP import reads it back as
      // the entity id and deletes whatever holds it, so letting the two drift
      // meant a later import deleted a different preset.
      await storage.schemaPresets.save({
        ...sp,
        presetId,
        // A duplicate is a new row, so it takes a new local key; a move keeps
        // the one it had. `entityId` follows the readable id either way.
        id: localId,
        entityId: duplicate ? presetId : (sp.entityId ?? presetId),
        // A git-linked preset exports as a POINTER, which carries its name at the
        // root and has no `mapping` at all — so spreading `sp.mapping` left the row
        // with no presetLabel, i.e. no name, until the repo was pulled. The clone
        // path already bridges the two; reuse it rather than re-deriving here.
        mapping: { ...reassemblePresetMapping(sp, sp.mapping), presetId },
        workspaceId: targetWsId,
      })
    }

    // --- Import databases (metadata only, no credentials/files) ---
    if (parsed.databases.length > 0) {
      reportPhase('workspaces.import_phase_databases', 0, parsed.databases.length)
      await yieldToBrowser()
    }
    for (const ds of parsed.databases) {
      if (!ds.id) continue
      // Lineage first — the manifest carries no local key, so that is what
      // recognises a re-import. A database written before databases had a lineage
      // (or by an older export) falls back to its id, which the flat form carried.
      const { id: byLineage } = await resolveByLineage(() => storage.dataSources.getAll(), ds)
      const landing = ds.lineageId ? byLineage : ds.id
      const id = duplicate ? crypto.randomUUID() : landing
      if (!duplicate) {
        const existing = await storage.dataSources.getById(landing)
        if (existing) {
          // Update metadata only, keep existing credentials and file refs
          await storage.dataSources.update(landing, {
            name: ds.name, description: ds.description, alias: ds.alias,
            schemaMapping: ds.schemaMapping, updatedAt: now,
          })
          continue
        }
      }
      await storage.dataSources.create({
        ...ds,
        id,
        workspaceId: targetWsId,
        status: 'disconnected',
        // The file carries the date the database was created; re-stamping it here
        // made every reimport read as brand new. Matches applyClonedDatabase.
        createdAt: ds.createdAt ?? now,
        updatedAt: now,
      } as import('@/types').DataSource)
    }

    // --- Import the workspace README's images ---
    await createEntityAttachments(storage, parsed.workspaceAttachments, 'workspace', targetWsId, targetWsId)

    // --- Import wiki pages ---
    if (parsed.wikiPages.length > 0) {
      reportPhase('workspaces.import_phase_wiki', 0, parsed.wikiPages.length)
      await yieldToBrowser()
      if (!duplicate) {
        await storage.wikiAttachments.deleteByWorkspace(targetWsId).catch(() => {})
        await storage.wikiPages.deleteByWorkspace(targetWsId).catch(() => {})
      }
      const wikiIdMap = new Map<string, string>()
      const mapWikiId = (oldId: string): string => {
        if (!duplicate) return oldId
        if (!wikiIdMap.has(oldId)) wikiIdMap.set(oldId, crypto.randomUUID())
        return wikiIdMap.get(oldId)!
      }
      for (const page of parsed.wikiPages) {
        await storage.wikiPages.create({
          ...page,
          id: mapWikiId(page.id),
          workspaceId: targetWsId,
          parentId: page.parentId ? mapWikiId(page.parentId) : null,
          updatedAt: now,
        })
      }
      for (const meta of parsed.wikiAttachmentsMeta) {
        const blobData = parsed.wikiAttachmentBlobs.get(meta.id)
        if (blobData) {
          await storage.wikiAttachments.create({
            ...meta,
            id: duplicate ? crypto.randomUUID() : meta.id,
            pageId: mapWikiId(meta.pageId),
            workspaceId: targetWsId,
            data: blobData,
          } as WikiAttachment)
        }
      }
    }

    // --- Import SQL script collections ---
    if (parsed.sqlCollections.length > 0) {
      reportPhase('workspaces.import_phase_sql', 0, parsed.sqlCollections.length)
      await yieldToBrowser()
    }
    for (const { collection, files } of parsed.sqlCollections) {
      const { id, replaces } = await resolveByLineage(() => storage.sqlScriptCollections.getAll(), collection)
      idMap.set(`sql-collection:${collection.entityId ?? collection.id}`, id)
      if (replaces) {
        await storage.sqlScriptFiles.deleteByCollection(replaces).catch(() => {})
        await storage.sqlScriptCollections.delete(replaces).catch(() => {})
      }
      await storage.sqlScriptCollections.create({
        ...collection, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate
          ? { name: copyLocalizedName(collection.name), createdAt: now, lineageId: crypto.randomUUID(), parentLineageId: collection.lineageId }
          : { lineageId: collection.lineageId ?? crypto.randomUUID() }),
      })
      // parseWorkspaceZip derived the ids from the ZIP's own collection id; when
      // the target id differs (a duplicate, or a plain import that dodged a
      // cross-workspace collision) re-derive them from the target so they can't
      // collide with the other workspace's files.
      const targetFiles = id === collection.id
        ? files
        : rederiveTreeIds(files, collection.id, id, 'collectionId')
      for (const f of targetFiles) {
        await storage.sqlScriptFiles.create({ ...f, collectionId: id })
      }
    }

    // --- Import ETL pipelines ---
    if (parsed.etlPipelines.length > 0) {
      reportPhase('workspaces.import_phase_etl', 0, parsed.etlPipelines.length)
      await yieldToBrowser()
    }
    for (const { pipeline, files, attachments } of parsed.etlPipelines) {
      const { id, replaces } = await resolveByLineage(() => storage.etlPipelines.getAll(), pipeline)
      idMap.set(`etl-pipeline:${pipeline.entityId ?? pipeline.id}`, id)
      if (replaces) {
        await storage.etlFiles.deleteByPipeline(replaces).catch(() => {})
        await storage.etlPipelines.delete(replaces).catch(() => {})
      }
      await storage.etlPipelines.create({
        ...pipeline, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate
          ? { name: copyLocalizedName(pipeline.name), createdAt: now, lineageId: crypto.randomUUID(), parentLineageId: pipeline.lineageId }
          : { lineageId: pipeline.lineageId ?? crypto.randomUUID() }),
      })
      const targetFiles = id === pipeline.id
        ? files
        : rederiveTreeIds(files, pipeline.id, id, 'pipelineId')
      for (const f of targetFiles) {
        await storage.etlFiles.create({ ...f, pipelineId: id })
      }
      await createEntityAttachments(storage, attachments, 'etl-pipeline', id, targetWsId)
    }

    // --- Import DQ rule sets ---
    if (parsed.dqRuleSets.length > 0) {
      reportPhase('workspaces.import_phase_dq', 0, parsed.dqRuleSets.length)
      await yieldToBrowser()
    }
    for (const { ruleSet, checks } of parsed.dqRuleSets) {
      const { id, replaces } = await resolveByLineage(() => storage.dqRuleSets.getAll(), ruleSet)
      idMap.set(`dq-rule-set:${ruleSet.entityId ?? ruleSet.id}`, id)
      if (replaces) {
        await storage.dqCustomChecks.deleteByRuleSet(replaces).catch(() => {})
        await storage.dqRuleSets.delete(replaces).catch(() => {})
      }
      await storage.dqRuleSets.create({
        ...ruleSet, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate
          ? { name: copyLocalizedName(ruleSet.name), createdAt: now, lineageId: crypto.randomUUID(), parentLineageId: ruleSet.lineageId }
          : { lineageId: ruleSet.lineageId ?? crypto.randomUUID() }),
      })
      const remintChecks = id !== ruleSet.id
      for (const check of checks) {
        await storage.dqCustomChecks.create({
          ...check, id: remintChecks ? crypto.randomUUID() : check.id, ruleSetId: id,
        })
      }
    }

    // --- Import concept sets ---
    if (parsed.conceptSets.length > 0) {
      reportPhase('workspaces.import_phase_concept_sets', 0, parsed.conceptSets.length)
      await yieldToBrowser()
    }
    for (const cs of parsed.conceptSets) {
      const id = await resolveChildId((i) => storage.conceptSets.getById(i), cs.id)
      if (id === cs.id) await storage.conceptSets.delete(cs.id).catch(() => {})
      await storage.conceptSets.create({
        ...cs, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: `${cs.name} (copy)`, createdAt: now } : {}),
      })
    }

    // --- Import mapping projects ---
    if (parsed.mappingProjects.length > 0) {
      const totalMappings = parsed.mappingProjects.reduce((s, mp) => s + mp.mappings.length, 0)
      reportPhase('workspaces.import_phase_mappings', 0, totalMappings)
      await yieldToBrowser()
      let mappingIdx = 0
      const reportEvery = Math.max(1, Math.floor(totalMappings / 100)) // ~100 UI updates max
      for (const { project: mp, mappings, scoresFile } of parsed.mappingProjects) {
        const { id, replaces } = await resolveByLineage(() => storage.mappingProjects.getAll(), mp)
        // Keyed on the identity the manifest actually carries. A git-linked
        // project exports as a pointer with no `id`, so every one of them keyed
        // this map at "mapping-project:undefined": each overwrote the last, and
        // all their clones then retargeted onto the single surviving id — six
        // projects imported empty while one received everyone's content.
        idMap.set(`mapping-project:${mp.entityId ?? mp.id}`, id)
        // The mappings' own ids are namespaced by the project id, so they must be
        // re-minted whenever this import did not land on the row it replaces.
        const remintMappings = !replaces
        if (replaces) {
          await storage.conceptMappings.deleteByProject(replaces).catch(() => {})
          await storage.mappingProjects.delete(replaces).catch(() => {})
        }
        await storage.mappingProjects.create({
          ...mp, id, workspaceId: targetWsId, updatedAt: now,
          ...(duplicate
            ? { name: copyLocalizedName(mp.name), createdAt: now, lineageId: crypto.randomUUID(), parentLineageId: mp.lineageId }
            : { lineageId: mp.lineageId ?? crypto.randomUUID() }),
        })
        if (scoresFile) {
          // Untrusted ZIP input — validate columns before persisting, same as the interactive load flow.
          if (isServerMode()) {
            // The server attach endpoint validates the parquet before storing it.
            const { persistScoresFileOnServer } = await import('@/lib/api/scores')
            await persistScoresFileOnServer(id, scoresFile).catch(() => {})
          } else {
            const [{ persistScoresFile }, { validateScoresFile }] = await Promise.all([
              import('@/lib/concept-mapping/scores-engine'),
              import('@/lib/concept-mapping/scores-parser'),
            ])
            const validation = await validateScoresFile(scoresFile)
            if (validation.ok) await persistScoresFile(id, scoresFile).catch(() => {})
          }
        }
        for (const m of mappings) {
          await storage.conceptMappings.create({
            ...m, id: remintMappings ? crypto.randomUUID() : m.id, projectId: id,
          })
          mappingIdx++
          if (mappingIdx % reportEvery === 0) {
            reportPhase('workspaces.import_phase_mappings', mappingIdx, totalMappings)
            await yieldToBrowser()
          }
        }
        // `stats` came in on the project.json we just wrote, but it is DERIVED
        // from these mappings — an export with stale counters would otherwise
        // keep displaying the wrong number here for good.
        const { recomputeImportedStats } = await import('@/lib/concept-mapping/import')
        await recomputeImportedStats(id, mp, storage)
      }
      reportPhase('workspaces.import_phase_mappings', totalMappings, totalMappings)
      await yieldToBrowser()
    }

    // --- Import source concept ID registry (ranges + entries) ---
    // Fire when EITHER is present: entries now come from per-project subfolders,
    // so a workspace can carry entries even if the root ranges.json is absent.
    if (parsed.sourceConceptIdRanges.length > 0 || parsed.sourceConceptIdEntries.length > 0) {
      reportPhase('workspaces.import_phase_source_id_registry', 0, parsed.sourceConceptIdEntries.length)
      await yieldToBrowser()
      if (!duplicate) {
        await storage.sourceConceptIdRanges.deleteByWorkspace(targetWsId).catch(() => {})
        await storage.sourceConceptIdEntries.deleteByWorkspace(targetWsId).catch(() => {})
      }
      for (const range of parsed.sourceConceptIdRanges) {
        const badgeLabel = duplicate ? `${range.badgeLabel} (copy)` : range.badgeLabel
        await storage.sourceConceptIdRanges.save({
          ...range, workspaceId: targetWsId, badgeLabel, createdAt: range.createdAt ?? now, updatedAt: now,
        })
      }
      if (parsed.sourceConceptIdEntries.length > 0) {
        await storage.sourceConceptIdEntries.saveBatch(
          parsed.sourceConceptIdEntries.map(entry => {
            const badgeLabel = duplicate ? `${entry.badgeLabel} (copy)` : entry.badgeLabel
            const newId = duplicate
              ? `${targetWsId}__${badgeLabel}__${entry.vocabularyId}__${entry.conceptCode}`
              : entry.id
            return { ...entry, id: newId, workspaceId: targetWsId, badgeLabel }
          })
        )
      }
    }

    // --- Import catalogs ---
    if (parsed.catalogs.length > 0) {
      reportPhase('workspaces.import_phase_catalogs', 0, parsed.catalogs.length)
      await yieldToBrowser()
    }
    for (const cat of parsed.catalogs) {
      const { id, replaces } = await resolveByLineage(() => storage.dataCatalogs.getAll(), cat)
      idMap.set(`data-catalog:${cat.entityId ?? cat.id}`, id)
      if (replaces) await storage.dataCatalogs.delete(replaces).catch(() => {})
      await storage.dataCatalogs.create({
        ...cat, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: copyLocalizedName(cat.name), createdAt: now } : {}),
      })
    }

    // --- Import service mappings ---
    if (parsed.serviceMappings.length > 0) {
      reportPhase('workspaces.import_phase_service_mappings', 0, parsed.serviceMappings.length)
      await yieldToBrowser()
    }
    for (const sm of parsed.serviceMappings) {
      const id = await resolveChildId((i) => storage.serviceMappings.getById(i), sm.id)
      if (id === sm.id) await storage.serviceMappings.delete(sm.id).catch(() => {})
      await storage.serviceMappings.create({
        ...sm, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { name: `${sm.name} (copy)`, createdAt: now } : {}),
      })
    }

    // --- Import plugins ---
    if (parsed.plugins.length > 0) {
      reportPhase('workspaces.import_phase_plugins', 0, parsed.plugins.length)
      await yieldToBrowser()
    }
    for (const plugin of parsed.plugins) {
      // The manifest carries no local key, so `plugin.id` was undefined here: the
      // delete below was a no-op and every re-import piled up another copy.
      // Lineage is what recognises the row, as for every other workspace child.
      const { id, replaces } = await resolveByLineage(() => storage.userPlugins.getAll(), plugin)
      if (replaces) await storage.userPlugins.delete(replaces).catch(() => {})
      await storage.userPlugins.create({
        ...plugin, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate ? { createdAt: now } : {}),
      })
    }
    // Built-in plugins are stripped from the export (reconstitutable from the app
    // registry), so re-seed them here — idempotent per workspace, unique row ids.
    await seedBuiltinPluginsForWorkspace(targetWsId)

    reportPhase('workspaces.import_phase_finalizing')
    await yieldToBrowser()

    // Invalidate in-memory caches so stores reload from IDB on next open
    useDashboardStore.setState({ activeProjectUid: null, loaded: false })
    useDatasetStore.setState({ activeProjectUid: null })
    useFileStore.setState({ activeProjectUid: null })
    useWikiStore.setState({ pagesLoaded: false, currentWorkspaceId: null })
    useSqlScriptsStore.setState({ collectionsLoaded: false })
    useEtlStore.setState({ etlPipelinesLoaded: false })
    useDqStore.setState({ dqRuleSetsLoaded: false })
    // NB: never flip catalogsLoaded to false — it feeds App.tsx's full-screen gate,
    // which would unmount this page (and kill the import-progress modal). Reload the
    // catalog store below instead (loadCatalogs sets the flag straight back to true).
    // Concept mapping: also clear the in-memory `mappings` array — leftover entries from a
    // previously-deleted workspace would otherwise pollute the new project view.
    {
      const cm = useConceptMappingStore.getState()
      useConceptMappingStore.setState({
        mappingProjectsLoaded: false,
        conceptSetsLoaded: false,
        mappings: [],
        mappingsById: new Map(),
        mappingsVersion: cm.mappingsVersion + 1,
        mappingsStructureVersion: cm.mappingsStructureVersion + 1,
        mappingsLoaded: false,
        activeProjectId: null,
        otherProjectsMappedKeys: new Set(),
        otherProjectsMappings: new Map(),
        _otherKeysLoadedFor: null,
        _otherDetailsLoadedFor: null,
      })
    }
    await useWorkspaceStore.getState().loadWorkspaces()
    // Import creates the linked organization straight through storage (bypassing
    // the org store), so reload it — else Settings > Organizations and the
    // workspace's org field stay empty until a full app reload.
    await useOrganizationStore.getState().loadOrganizations()
    await loadProjects()
    // catalogsLoaded feeds the global App-shell gate: leaving it false replaces the
    // whole app with a full-screen loader. Reload it now (flips the flag back to true)
    // instead of waiting for some later loadCatalogs() to un-block the shell.
    await useCatalogStore.getState().loadCatalogs()
    return { targetWsId, idMap, skippedOrgName }
  }, [loadProjects, i18n.language])

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
      <ImportSourceDialog open={importOpen} onOpenChange={setImportOpen} accept=".zip" onImport={handleImportSource} />

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
