import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Puzzle, Trash2, Download, Upload, MoreHorizontal, Copy, Info, Search, Pencil, GitBranch } from 'lucide-react'
import JSZip from 'jszip'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ListPageToolbar, type FilterGroup } from '@/components/ui/list-page-toolbar'
import { cn } from '@/lib/utils'
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePluginEditorStore, type PluginListItem } from '@/stores/plugin-editor-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { getAllPlugins } from '@/lib/plugins/registry'
import { getStorage } from '@/lib/storage'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
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

function ScopeBanner({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 dark:border-blue-900 dark:bg-blue-950/40">
      <Info size={14} className="mt-0.5 shrink-0 text-blue-500" />
      <p className="text-xs text-blue-700 dark:text-blue-300">{text}</p>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Plugin card
// ---------------------------------------------------------------------------

interface PluginCardProps {
  plugin: PluginListItem
  lang: 'en' | 'fr'
  onOpen: (id: string) => void
  onEdit: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onVersioning: (id: string, tab: 'export' | 'git') => void
  t: (key: string) => string
}

function PluginCard({ plugin, lang, onOpen, onEdit, onDuplicate, onDelete, onVersioning, t }: PluginCardProps) {
  const Icon = getPluginIcon(plugin.manifest.icon)
  const readOnly = plugin.readOnly
  const iconProps = getPluginIconColorProps(plugin.manifest.iconColor)
  return (
    <Card
      key={plugin.id}
      className={cn(
        'relative transition-colors',
        readOnly ? 'cursor-default' : 'cursor-pointer hover:bg-accent/50',
      )}
      onClick={readOnly ? undefined : () => onOpen(plugin.id)}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              {/* eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data */}
              <Icon size={16} className={iconProps.className ?? 'text-primary'} style={iconProps.style} />
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
                  <Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}>
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
        {(plugin.manifest.description?.[lang] ?? plugin.manifest.description?.en) && (
          <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
            {plugin.manifest.description?.[lang] ?? plugin.manifest.description?.en}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {plugin.manifest.badges?.map((badge) => (
            <span
              key={badge.id}
              className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium leading-tight', getBadgeClasses(badge.color))}
              style={getBadgeStyle(badge.color)}
            >
              {badge.label}
            </span>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            {plugin.manifest.languages?.map((l) => (
              <LanguageBadge key={l} language={l} />
            ))}
            <span className="shrink-0 text-[10px] text-muted-foreground">
              v{plugin.manifest.version ?? '1.0.0'}
            </span>
          </div>
        </div>
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
    addBuiltinPlugin,
    activePluginTab: activeTab,
    setActivePluginTab: setActiveTab,
  } = usePluginEditorStore()

  // Plugins are workspace-scoped: creating one needs an open workspace.
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const canWrite = useMyWorkspaceRole().can('plugins:write')
  const pluginActions = usePluginActions()
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [showAddDefaultDialog, setShowAddDefaultDialog] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editTargetId, setEditTargetId] = useState<string | null>(null)
  const [versioningTarget, setVersioningTarget] = useState<{ id: string; tab: 'export' | 'git' } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])

  // Built-in plugins available to add (not already in this workspace)
  const currentPluginManifestIds = new Set(pluginList.map(p => p.manifestId))
  const availableBuiltins = useMemo(() => {
    return getAllPlugins()
      .filter(p => !p.workspaceId && !currentPluginManifestIds.has(p.manifest.id))
      .map(p => p.manifest)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPluginManifestIds.size])
  const importInputRef = useRef<HTMLInputElement>(null)
  const [importConflict, setImportConflict] = useState<{ name: string; files: Record<string, string>; pluginId: string } | null>(null)

  // Refresh when the active workspace changes too — the list is workspace-scoped,
  // so switching to or creating a workspace must reload its (seeded) plugins.
  useEffect(() => {
    refreshPluginList()
  }, [refreshPluginList, activeWorkspaceId])

  // A plugin opened in another workspace must not leak across a workspace switch:
  // once the (workspace-scoped) list is loaded, if the open plugin isn't part of it,
  // close the editor so /plugins shows the widget list, not a stale plugin.
  const closeEditor = usePluginEditorStore((s) => s.closeEditor)
  useEffect(() => {
    if (editingPluginId && pluginList.length > 0 && !pluginList.some((p) => p.id === editingPluginId)) {
      closeEditor()
    }
  }, [editingPluginId, pluginList, closeEditor])

  // All badge labels across plugins (for the filter dropdown)
  const allBadges = useMemo(() => {
    const byLabel = new Map<string, string>()
    for (const p of pluginList) for (const b of p.manifest.badges ?? []) if (b.label && !byLabel.has(b.label)) byLabel.set(b.label, b.color)
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, color]) => ({ label, color }))
  }, [pluginList])

  const filteredPlugins = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    return pluginList.filter((p) => {
      if (words.length) {
        const text = `${p.manifest.name?.en ?? ''} ${p.manifest.name?.fr ?? ''} ${p.manifest.description?.en ?? ''} ${p.manifest.description?.fr ?? ''}`.toLowerCase()
        if (!words.every((w) => text.includes(w))) return false
      }
      if (badgeFilter.length) {
        const labels = new Set((p.manifest.badges ?? []).map((b) => b.label))
        if (!badgeFilter.some((l) => labels.has(l))) return false
      }
      return true
    })
  }, [pluginList, searchQuery, badgeFilter])

  // Split filtered plugins by scope
  const warehousePlugins = useMemo(
    () => filteredPlugins.filter(p => p.manifest.scope === 'warehouse'),
    [filteredPlugins],
  )
  const labPlugins = useMemo(
    () => filteredPlugins.filter(p => (p.manifest.scope ?? 'lab') === 'lab'),
    [filteredPlugins],
  )

  const filterGroups = useMemo<FilterGroup[]>(() => allBadges.length === 0 ? [] : [
    {
      key: 'badges',
      label: t('plugins.filter_badges'),
      selected: badgeFilter,
      onChange: setBadgeFilter,
      options: allBadges.map((b) => ({
        value: b.label,
        label: b.label,
        badgeClass: getBadgeClasses(b.color),
        badgeStyle: getBadgeStyle(b.color),
      })),
    },
  ], [t, badgeFilter, allBadges])

  // Import a plugin from ZIP
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
    // Parse plugin.json to get ID
    let pluginId = crypto.randomUUID()
    let pluginName = 'Imported Plugin'
    try {
      const manifest = JSON.parse(files['plugin.json'] ?? '{}')
      if (manifest.id) pluginId = manifest.id
      if (manifest.name?.en) pluginName = manifest.name.en
    } catch { /* ignore */ }

    const existing = await getStorage().userPlugins.getById(pluginId)
    if (existing) {
      setImportConflict({ name: pluginName, files, pluginId })
    } else {
      await doPluginImport(files, pluginId, false)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const doPluginImport = useCallback(async (files: Record<string, string>, pluginId: string, duplicate: boolean) => {
    const id = duplicate ? crypto.randomUUID() : pluginId
    // If duplicating, update plugin.json with new ID and name
    const updatedFiles = { ...files }
    if (duplicate) {
      try {
        const manifest = JSON.parse(files['plugin.json'] ?? '{}')
        manifest.id = id
        if (manifest.name?.en) manifest.name.en = `${manifest.name.en} (copy)`
        if (manifest.name?.fr) manifest.name.fr = `${manifest.name.fr} (copie)`
        updatedFiles['plugin.json'] = JSON.stringify(manifest, null, 2)
      } catch { /* ignore */ }
    }
    if (!duplicate) {
      // Overwrite: delete old plugin first
      await getStorage().userPlugins.delete(pluginId).catch(() => {})
    }
    const nowIso = new Date().toISOString()
    await getStorage().userPlugins.create({ id, files: updatedFiles, createdAt: nowIso, updatedAt: nowIso })
    await refreshPluginList()
  }, [refreshPluginList])

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
            onOpen={openPlugin}
            onEdit={setEditTargetId}
            onDuplicate={duplicatePlugin}
            onDelete={setDeleteId}
            onVersioning={(id, tab) => setVersioningTarget({ id, tab })}
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
          {availableBuiltins.length > 0 && (
            <Button size="sm" variant="outline" disabled={!activeWorkspaceId || !canWrite} onClick={() => setShowAddDefaultDialog(true)} className="gap-1 text-xs">
              <Puzzle size={14} />
              {t('plugins.add_default')}
            </Button>
          )}
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
        />
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'warehouse' | 'lab')} className="mt-4">
        <TabsList className="mx-auto">
          <TabsTrigger value="warehouse">{t('plugins.tab_warehouse')}</TabsTrigger>
          <TabsTrigger value="lab">{t('plugins.tab_lab')}</TabsTrigger>
        </TabsList>
        <TabsContent value="warehouse" className="mt-4 space-y-4">
          <ScopeBanner text={t('plugins.banner_warehouse')} />
          {renderPluginGrid(warehousePlugins)}
        </TabsContent>
        <TabsContent value="lab" className="mt-4 space-y-4">
          <ScopeBanner text={t('plugins.banner_lab')} />
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

      {/* Export & versioning (git remote) — same dialog as other entities */}
      {versioningTarget && (
        <EntityVersioningDialog
          open
          onOpenChange={(open) => { if (!open) setVersioningTarget(null) }}
          initialTab={versioningTarget.tab}
          supportsIncludeData={false}
          gitRemote={pluginList.find((p) => p.id === versioningTarget.id)?.gitRemoteConfig ?? null}
          onExport={() => pluginActions.onExport({ id: versioningTarget.id, name: versioningTarget.id })}
          onSaveGitRemote={async (config) => {
            await pluginActions.onSaveGitRemote({ id: versioningTarget.id, name: versioningTarget.id }, config)
          }}
        />
      )}

      {/* Add default plugin dialog */}
      <Dialog open={showAddDefaultDialog} onOpenChange={setShowAddDefaultDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('plugins.add_default')}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-1.5 overflow-auto py-2">
            {availableBuiltins.map(manifest => {
              const Icon = getPluginIcon(manifest.icon)
              return (
                <button
                  key={manifest.id}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent"
                  onClick={async () => {
                    await addBuiltinPlugin(manifest.id)
                    setShowAddDefaultDialog(false)
                  }}
                >
                  <Icon size={18} className={cn('shrink-0', getPluginIconColorProps(manifest.iconColor).className)} style={getPluginIconColorProps(manifest.iconColor).style} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{manifest.name?.[lang] ?? manifest.name?.en ?? manifest.id}</p>
                    {manifest.description && (
                      <p className="text-xs text-muted-foreground line-clamp-1">{manifest.description?.[lang] ?? manifest.description?.en}</p>
                    )}
                  </div>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {manifest.scope === 'warehouse' ? t('plugins.scope_warehouse') : t('plugins.scope_lab')}
                  </span>
                </button>
              )
            })}
            {availableBuiltins.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">{t('plugins.no_defaults_available')}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

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
