import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type { EntityLicense } from '@/types'
import { useTranslation } from 'react-i18next'
import { Plus, Puzzle, Trash2, Download, Upload, MoreHorizontal, Copy, Search, Pencil, GitBranch } from 'lucide-react'
import JSZip from 'jszip'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { EntityDocsDialog, type DocsTab } from '@/components/ui/entity-docs-dialog'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { TruncatedText } from '@/components/ui/truncated-text'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { localized } from '@/lib/localized'
import { cn, cardMenuTriggerClass } from '@/lib/utils'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePluginEditorStore, type PluginListItem } from '@/stores/plugin-editor-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { stampAuthored } from '@/stores/app-store'
import type { AuthorDetails, OrganizationInfo } from '@/types'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { getStorage } from '@/lib/storage'
import { badgeFilterOptions } from '@/lib/badge-filter-options'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { EntityVersioningDialog } from '@/components/ui/entity-versioning-dialog'
import { getPluginIcon, getPluginIconColorProps } from './plugin-icon'
import { PluginSettingsDialog } from './PluginSettingsDialog'
import { usePluginActions } from './use-plugin-actions'
import { PluginEditor } from './PluginEditor'

const LANG_BADGE: Record<string, { label: string; color: string }> = {
  python: { label: 'PY', color: 'text-yellow-500 bg-yellow-500/10' },
  r: { label: 'R', color: 'text-blue-500 bg-blue-500/10' },
}

function LanguageBadge({ language }: { language: string }) {
  const badge = LANG_BADGE[language]
  if (!badge) return null
  return (
    <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight', badge.color)}>
      {badge.label}
    </span>
  )
}



// ---------------------------------------------------------------------------
// Plugin card
// ---------------------------------------------------------------------------

interface PluginCardProps {
  plugin: PluginListItem
  lang: 'en' | 'fr'
  /** Org the plugin inherits from its workspace, resolved live for the hover. */
  organizationId?: string
  onOpen: (id: string) => void
  onEdit: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onVersioning: (id: string, tab: 'export' | 'git') => void
  license?: EntityLicense | null
  /** Opens the README/licence dialog on `tab`. Absent for read-only plugins. */
  onOpenDocs?: (tab: DocsTab) => void
  t: (key: string) => string
}

function PluginCard({ plugin, lang, organizationId, onOpen, onEdit, onDuplicate, onDelete, onVersioning, license, onOpenDocs, t }: PluginCardProps) {
  const Icon = getPluginIcon(plugin.manifest.icon)
  const readOnly = plugin.readOnly
  const iconProps = getPluginIconColorProps(plugin.manifest.iconColor)
  return (
    <Card
      key={plugin.id}
      className={cn(
        'relative flex min-h-44 flex-col gap-0 py-0 transition-colors',
        readOnly ? 'cursor-default' : 'cursor-pointer hover:bg-accent',
      )}
      onClick={readOnly ? undefined : () => onOpen(plugin.id)}
    >
      <div className="flex flex-1 flex-col px-4 pt-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              {/* eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data */}
              <Icon size={20} className={iconProps.className ?? 'text-primary'} style={iconProps.style} />
            </div>
            <span className="truncate text-sm font-medium text-card-foreground">
              {plugin.manifest.name?.[lang] ?? plugin.manifest.name?.en ?? plugin.id}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {readOnly && (
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted-foreground bg-muted">
                {plugin.isSystemPlugin ? t('plugins.system_plugin') : t('plugins.builtin_badge')}
              </span>
            )}
            {/* Built-in & system plugins are read-only (code lives in the bundle) — no actions. */}
            {!readOnly && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className={cardMenuTriggerClass} onClick={(e) => e.stopPropagation()}>
                    <MoreHorizontal size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit(plugin.id) }}>
                    <Pencil size={14} />
                    {t('common.edit')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onVersioning(plugin.id, 'export') }}>
                    <Download size={14} />
                    {t('common.export')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onVersioning(plugin.id, 'git') }}>
                    <GitBranch size={14} />
                    {t('common.versioning')}
                  </DropdownMenuItem>
                  {/* No Readme or Licence items: the card footer's licence chip
                      opens the docs, as on every other entity card. */}
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDuplicate(plugin.id) }}>
                    <Copy size={14} />
                    {t('common.duplicate')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); onDelete(plugin.id) }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 size={14} className="text-destructive" />
                    {t('common.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        <div className="mt-0.5 h-4">
          {(plugin.manifest.description?.[lang] ?? plugin.manifest.description?.en) && (
            <TruncatedText
              text={plugin.manifest.description?.[lang] ?? plugin.manifest.description?.en ?? ''}
              readOnly
              className="text-xs text-muted-foreground"
            />
          )}
        </div>
        <BadgeStrip badges={plugin.manifest.badges ?? []} className="mt-2 h-5" />
        {/* Languages + version pinned to the bottom-right, just above the footer bar. */}
        <div className="mt-auto flex items-center justify-end gap-1.5 pt-2">
          {plugin.manifest.languages?.map((l) => (
            <LanguageBadge key={l} language={l} />
          ))}
          <span className="shrink-0 text-[10px] text-muted-foreground">
            v{plugin.manifest.version ?? '1.0.0'}
          </span>
        </div>
        <CardMetaFooter
          createdById={plugin.createdById}
          createdBy={plugin.createdBy}
          createdByDetails={plugin.createdByDetails}
          organizationId={organizationId}
          organization={plugin.organization}
          createdAt={plugin.createdAt}
          updatedAt={plugin.updatedAt}
          license={license}
          onOpenLicense={onOpenDocs && (() => onOpenDocs('license'))}
        />
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// PluginsTab
// ---------------------------------------------------------------------------

export function PluginsTab() {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const {
    pluginList,
    refreshPluginList,
    editingPluginId,
    openPlugin,
    duplicatePlugin,
    deletePlugin,
    activePluginTab: activeTab,
    setActivePluginTab: setActiveTab,
  } = usePluginEditorStore()

  // Plugins are workspace-scoped: creating one needs an open workspace.
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  // Plugins inherit their org from the workspace (no org field of their own),
  // resolved live so the author-hover shows it like every other entity card.
  const workspaceOrgId = useWorkspaceStore((s) =>
    s._workspacesRaw.find((w) => w.id === s.activeWorkspaceId)?.organizationId,
  )
  const canWrite = useMyWorkspaceRole().can('plugins:write')
  const pluginActions = usePluginActions()
  // A card's licence chip opens the shared readme/licence dialog on its License tab.
  const [docsTarget, setDocsTarget] = useState<{ id: string; tab: DocsTab } | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editTargetId, setEditTargetId] = useState<string | null>(null)
  const [versioningTarget, setVersioningTarget] = useState<{ id: string; tab: 'export' | 'git' } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const [typeFilter, setTypeFilter] = useState<string[]>([])
  const [sort, setSort] = useState<SortState | null>(null)

  const importInputRef = useRef<HTMLInputElement>(null)
  const [importConflict, setImportConflict] = useState<{ name: string; files: Record<string, string>; pluginId: string } | null>(null)

  // Refresh when the active workspace changes too — the list is workspace-scoped,
  // so switching to or creating a workspace must reload its (seeded) plugins.
  useEffect(() => {
    refreshPluginList()
  }, [refreshPluginList, activeWorkspaceId])

  // A plugin opened in another workspace must not leak across a workspace switch:
  // once the list has loaded FOR THE ACTIVE workspace, if the open plugin isn't
  // part of it, close the editor so /plugins shows the widget list, not a stale
  // plugin. Gate on the list's workspace marker (not pluginList.length) so a
  // switch into a genuinely-empty workspace still closes the stale editor.
  const closeEditor = usePluginEditorStore((s) => s.closeEditor)
  const pluginListWorkspaceId = usePluginEditorStore((s) => s.pluginListWorkspaceId)
  useEffect(() => {
    const listReady = pluginListWorkspaceId === (activeWorkspaceId ?? null)
    if (editingPluginId && listReady && !pluginList.some((p) => p.id === editingPluginId)) {
      closeEditor()
    }
  }, [editingPluginId, pluginList, pluginListWorkspaceId, activeWorkspaceId, closeEditor])

  // All badge labels across plugins (for the filter dropdown)
  const badgeCategories = useBadgeCategories()
  const allBadges = useMemo(() => {
    const byLabel = new Map<string, string>()
    for (const p of pluginList) for (const b of p.manifest.badges ?? []) {
      const label = localized(b.label, lang)
      if (label && !byLabel.has(label)) byLabel.set(label, b.color)
    }
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, color]) => ({ label, color }))
  }, [pluginList, lang])

  const filteredPlugins = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = pluginList.filter((p) => {
      if (words.length) {
        const text = `${p.manifest.name?.en ?? ''} ${p.manifest.name?.fr ?? ''} ${p.manifest.description?.en ?? ''} ${p.manifest.description?.fr ?? ''}`.toLowerCase()
        if (!words.every((w) => text.includes(w))) return false
      }
      if (badgeFilter.length) {
        const labels = new Set((p.manifest.badges ?? []).map((b) => localized(b.label, lang)))
        if (!badgeFilter.some((l) => labels.has(l))) return false
      }
      if (typeFilter.length) {
        const kind = p.isBuiltIn ? 'builtin' : 'custom'
        if (!typeFilter.includes(kind)) return false
      }
      return true
    })
    return applySort(filtered, sort, {
      name: (p) => p.manifest.name?.[lang] ?? p.manifest.name?.en ?? p.id,
      createdAt: (p) => p.createdAt,
      updatedAt: (p) => p.updatedAt,
    })
  }, [pluginList, searchQuery, badgeFilter, typeFilter, sort, lang])

  // Split filtered plugins by scope
  const warehousePlugins = useMemo(
    () => filteredPlugins.filter(p => p.manifest.scope === 'warehouse'),
    [filteredPlugins],
  )
  const labPlugins = useMemo(
    () => filteredPlugins.filter(p => (p.manifest.scope ?? 'lab') === 'lab'),
    [filteredPlugins],
  )

  const filterGroups = useMemo<FilterGroup[]>(() => {
    const groups: FilterGroup[] = [
      {
        key: 'type',
        label: t('plugins.filter_type'),
        selected: typeFilter,
        onChange: setTypeFilter,
        options: [
          { value: 'custom', label: t('plugins.custom') },
          { value: 'builtin', label: t('plugins.builtin_badge') },
        ],
      },
    ]
    if (allBadges.length > 0) {
      groups.push({
        key: 'badges',
        label: t('plugins.filter_badges'),
        selected: badgeFilter,
        onChange: setBadgeFilter,
        options: badgeFilterOptions(allBadges, badgeCategories, i18n.language, t('badge_categories.no_category')),
      })
    }
    return groups
  }, [t, badgeFilter, typeFilter, allBadges])

  // Import a plugin from ZIP. The row id is a per-workspace UUID; the manifest id
  // (shared identity) stays in plugin.json + entityId. Conflicts are detected by
  // manifest id within the current workspace.
  const doPluginImport = useCallback(async (files: Record<string, string>, manifestId: string, duplicate: boolean) => {
    const updatedFiles = { ...files }
    // `_plugin.json` is the export metadata pointer (author/org provenance), not a
    // plugin source file — pull it out and keep it from being stored as content.
    let meta: { createdBy?: string; createdByDetails?: AuthorDetails; organization?: OrganizationInfo } = {}
    if (updatedFiles['_plugin.json']) {
      try { meta = JSON.parse(updatedFiles['_plugin.json']) } catch { /* ignore */ }
      delete updatedFiles['_plugin.json']
    }
    // finalizeEntityZip writes `.gitattributes` when a plugin bundles an LFS-tracked
    // file — export metadata, not plugin source, so keep it out of the file map.
    delete updatedFiles['.gitattributes']
    let effectiveManifestId = manifestId
    if (duplicate) {
      try {
        const manifest = JSON.parse(files['plugin.json'] ?? '{}')
        effectiveManifestId = `${manifest.id ?? manifestId}-copy-${Date.now()}`
        manifest.id = effectiveManifestId
        if (manifest.name?.en) manifest.name.en = `${manifest.name.en} (copy)`
        if (manifest.name?.fr) manifest.name.fr = `${manifest.name.fr} (copie)`
        updatedFiles['plugin.json'] = JSON.stringify(manifest, null, 2)
      } catch { /* ignore */ }
    } else {
      // Overwrite: delete the existing row(s) with this manifest id in this workspace.
      const existing = pluginList.find((p) => p.manifestId === manifestId)
      if (existing) await getStorage().userPlugins.delete(existing.id).catch(() => {})
    }
    // Preserve the original author/org snapshot when the ZIP carries one (matches
    // project import); fall back to stamping the importing user for a bare-manifest
    // ZIP with no provenance. createdById is never imported (local id).
    const authored = meta.createdBy || meta.createdByDetails
      ? { createdBy: meta.createdBy, createdByDetails: meta.createdByDetails }
      : stampAuthored()
    const nowIso = new Date().toISOString()
    await getStorage().userPlugins.create({
      id: crypto.randomUUID(),
      entityId: effectiveManifestId,
      files: updatedFiles,
      ...authored,
      ...(meta.organization ? { organization: meta.organization } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
      workspaceId: activeWorkspaceId ?? undefined,
    })
    await refreshPluginList()
  }, [refreshPluginList, pluginList, activeWorkspaceId])

  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const zip = await JSZip.loadAsync(file)
    const files: Record<string, string> = {}
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      files[path] = await entry.async('string')
    }
    let manifestId = crypto.randomUUID()
    let pluginName = 'Imported Plugin'
    try {
      const manifest = JSON.parse(files['plugin.json'] ?? '{}')
      if (manifest.id) manifestId = manifest.id
      if (manifest.name?.en) pluginName = manifest.name.en
    } catch { /* ignore */ }

    // Conflict = same manifest id already in THIS workspace.
    const existing = pluginList.find((p) => p.manifestId === manifestId)
    if (existing) {
      setImportConflict({ name: pluginName, files, pluginId: manifestId })
    } else {
      await doPluginImport(files, manifestId, false)
    }
  }, [pluginList, doPluginImport])

  // If editing a plugin, show the editor instead of the list
  if (editingPluginId) {
    return <PluginEditor />
  }

  const hasQuery = searchQuery.trim().length > 0 || badgeFilter.length > 0

  const renderPluginGrid = (plugins: PluginListItem[]) => (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            lang={lang}
            // The plugin's own org (an imported plugin's frozen origin org) wins over
            // the workspace's — matching every other entity and the export precedence
            // (attachEntityOrganization). Only fall back to the workspace org when the
            // plugin carries none; passing the workspace id here would let liveOrg
            // shadow the imported org in CardMetaFooter (liveOrg ?? organization).
            organizationId={plugin.organization ? undefined : workspaceOrgId}
            onOpen={openPlugin}
            onEdit={setEditTargetId}
            onDuplicate={duplicatePlugin}
            onDelete={setDeleteId}
            onVersioning={(id, tab) => setVersioningTarget({ id, tab })}
            license={pluginActions.docs.getLicense({ id: plugin.id, name: plugin.manifest.name ?? plugin.id })}
            onOpenDocs={plugin.readOnly ? undefined : (tab) => setDocsTarget({ id: plugin.id, tab })}
            t={t}
          />
        ))}
      </div>
      {plugins.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          {hasQuery ? (
            <>
              <Search size={32} className="text-muted-foreground/30" />
              <p className="mt-2 text-sm text-muted-foreground">{t('plugins.no_results')}</p>
            </>
          ) : (
            <>
              <Puzzle size={32} className="text-muted-foreground/30" />
              <p className="mt-2 text-sm text-muted-foreground">{t('plugins.no_plugins')}</p>
            </>
          )}
        </div>
      )}
    </>
  )

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('plugins.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('plugins.description')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs"
            disabled={!canWrite}
            onClick={() => importInputRef.current?.click()}
          >
            <Upload size={14} />
            {t('common.import')}
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={handleImportFile}
          />
          <Button
            size="sm"
            disabled={!activeWorkspaceId || !canWrite}
            title={!activeWorkspaceId ? t('plugins.requires_workspace') : undefined}
            onClick={() => setShowCreateDialog(true)}
            className="gap-1 text-xs"
          >
            <Plus size={14} />
            {t('plugins.new_plugin')}
          </Button>
        </div>
      </div>

      {pluginList.length > 0 && (
        <ListPageToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchPlaceholder={t('plugins.search_placeholder')}
          filterGroups={filterGroups}
          sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
        />
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'warehouse' | 'lab')} className="mt-4">
        <TabsList className="mx-auto">
          <TabsTrigger value="warehouse">{t('plugins.tab_warehouse')}</TabsTrigger>
          <TabsTrigger value="lab">{t('plugins.tab_lab')}</TabsTrigger>
        </TabsList>
        <TabsContent value="warehouse" className="mt-4">
          {renderPluginGrid(warehousePlugins)}
        </TabsContent>
        <TabsContent value="lab" className="mt-4">
          {renderPluginGrid(labPlugins)}
        </TabsContent>
      </Tabs>

      {/* Create plugin dialog — same UI as Edit; scope follows the active tab; builds on submit */}
      <PluginSettingsDialog
        open={showCreateDialog}
        mode="create"
        scope={activeTab === 'warehouse' ? 'warehouse' : 'lab'}
        onOpenChange={setShowCreateDialog}
      />

      {/* Edit plugin metadata from the list (same modal, no code editor) */}
      {editTargetId && (
        <PluginSettingsDialog
          open
          mode="edit"
          pluginId={editTargetId}
          onOpenChange={(o) => { if (!o) setEditTargetId(null) }}
        />
      )}

      {/* Readme + licence, opened by a card's licence chip or its "..." menu */}
      {docsTarget && (() => {
        const row = pluginList.find((p) => p.id === docsTarget.id)
        const item = { id: docsTarget.id, name: row?.manifest.name ?? docsTarget.id }
        return (
          <EntityDocsDialog
            open
            onOpenChange={(open) => { if (!open) setDocsTarget(null) }}
            initialTab={docsTarget.tab}
            entityName={localized(item.name, lang)}
            readme={pluginActions.docs.getReadme(item)}
            onSaveReadme={(readme) => pluginActions.docs.onSaveReadme(item, readme)}
            license={pluginActions.docs.getLicense(item)}
            onSaveLicense={(license) => pluginActions.docs.onSaveLicense(item, license)}
            attachmentOwner={{ type: 'user-plugin', id: docsTarget.id, workspaceId: activeWorkspaceId ?? undefined }}
          />
        )
      })()}

      {/* Export & versioning (git remote) — same dialog as other entities */}
      {versioningTarget && (
        <EntityVersioningDialog
          open
          onOpenChange={(open) => { if (!open) setVersioningTarget(null) }}
          initialTab={versioningTarget.tab}
          supportsIncludeData={false}
          syncScope="user-plugins"
          syncId={versioningTarget.id}
          gitRemote={pluginList.find((p) => p.id === versioningTarget.id)?.gitRemoteConfig ?? null}
          onExport={() => pluginActions.onExport({ id: versioningTarget.id, name: versioningTarget.id })}
          onSaveGitRemote={async (config) => {
            await pluginActions.onSaveGitRemote({ id: versioningTarget.id, name: versioningTarget.id }, config)
          }}
        />
      )}

      {/* Import conflict */}
      <ImportConflictDialog
        open={!!importConflict}
        onOpenChange={(open) => { if (!open) setImportConflict(null) }}
        existingName={importConflict?.name ?? ''}
        onDuplicate={() => { if (importConflict) doPluginImport(importConflict.files, importConflict.pluginId, true); setImportConflict(null) }}
        onOverwrite={() => { if (importConflict) doPluginImport(importConflict.files, importConflict.pluginId, false); setImportConflict(null) }}
      />

      {/* Delete confirmation */}
      <AlertDialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('plugins.delete')}</AlertDialogTitle>
            <AlertDialogDescription>{t('plugins.delete_confirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => { if (deleteId) { deletePlugin(deleteId); setDeleteId(null) } }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
