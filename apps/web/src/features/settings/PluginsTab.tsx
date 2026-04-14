import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Puzzle, Trash2, Download, Upload, MoreHorizontal, Copy, History } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import JSZip from 'jszip'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
  DialogFooter,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { usePluginEditorStore, type PluginListItem } from '@/stores/plugin-editor-store'
import { getAllPlugins } from '@/lib/plugins/registry'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { getStorage } from '@/lib/storage'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { PluginEditor } from './PluginEditor'
import type { PluginScope } from '@/types/plugin'

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

function getIcon(iconName: string): LucideIcons.LucideIcon {
  const icon = (LucideIcons as Record<string, unknown>)[iconName]
  if (typeof icon === 'object' && icon !== null) return icon as LucideIcons.LucideIcon
  return Puzzle
}

/** Map preset color names to Tailwind text classes for icon coloring. */
const ICON_COLOR_CLASS: Record<string, string> = {
  red: 'text-red-500',
  blue: 'text-blue-500',
  green: 'text-green-500',
  violet: 'text-violet-500',
  amber: 'text-amber-500',
  rose: 'text-rose-500',
  cyan: 'text-cyan-500',
  slate: 'text-slate-500',
}

function getIconColorProps(iconColor?: string): { className?: string; style?: React.CSSProperties } {
  if (!iconColor) return { className: 'text-muted-foreground' }
  const tw = ICON_COLOR_CLASS[iconColor]
  if (tw) return { className: tw }
  return { style: { color: iconColor } }
}

// ---------------------------------------------------------------------------
// Plugin card
// ---------------------------------------------------------------------------

interface PluginCardProps {
  plugin: PluginListItem
  lang: 'en' | 'fr'
  onOpen: (id: string) => void
  onExport: (id: string, e: React.MouseEvent) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  t: (key: string) => string
}

function PluginCard({ plugin, lang, onOpen, onExport, onDuplicate, onDelete, t }: PluginCardProps) {
  const Icon = getIcon(plugin.manifest.icon)
  const isSystem = plugin.isSystemPlugin
  return (
    <button
      key={plugin.id}
      type="button"
      onClick={() => onOpen(plugin.id)}
      className="relative flex flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent/50"
    >
      {/* Action menu — top-right */}
      <div className="absolute right-2 top-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={(e) => onExport(plugin.id, e as unknown as React.MouseEvent)}>
              <Download size={14} />
              {t('common.export')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDuplicate(plugin.id) }}>
              <Copy size={14} />
              {t('common.duplicate')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              <History size={14} />
              {t('common.history')}
              <span className="ml-auto inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground leading-none">{t('common.server_only')}</span>
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
      </div>
      <div className="flex items-center gap-2 pr-6">
        <Icon size={18} className={cn('shrink-0', getIconColorProps(plugin.manifest.iconColor).className)} style={getIconColorProps(plugin.manifest.iconColor).style} />
        <span className="text-sm font-medium truncate">
          {plugin.manifest.name?.[lang] ?? plugin.manifest.name?.en ?? plugin.id}
        </span>
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2">
        {plugin.manifest.description?.[lang] ?? plugin.manifest.description?.en ?? ''}
      </p>
      <div className="flex items-center gap-1 flex-wrap">
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
          {isSystem && (
            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted-foreground bg-muted">
              {t('plugins.system_plugin')}
            </span>
          )}
          {plugin.manifest.languages?.map((l) => (
            <LanguageBadge key={l} language={l} />
          ))}
          <span className="text-[10px] text-muted-foreground shrink-0">
            v{plugin.manifest.version ?? '1.0.0'}
          </span>
        </div>
      </div>
    </button>
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
    createPlugin,
    duplicatePlugin,
    deletePlugin,
    addBuiltinPlugin,
    activePluginTab: activeTab,
    setActivePluginTab: setActiveTab,
  } = usePluginEditorStore()

  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showAddDefaultDialog, setShowAddDefaultDialog] = useState(false)
  const [newPluginName, setNewPluginName] = useState('')
  const [newPluginEntityId, setNewPluginEntityId] = useState('')
  const [createScope, setCreateScope] = useState<PluginScope>('lab')
  const existingPluginIds = pluginList.map(p => p.entityId).filter((id): id is string => !!id)

  // Built-in plugins available to add (not already in this workspace)
  const currentPluginManifestIds = new Set(pluginList.map(p => p.id))
  const availableBuiltins = useMemo(() => {
    return getAllPlugins()
      .filter(p => !p.workspaceId && !currentPluginManifestIds.has(p.manifest.id))
      .map(p => p.manifest)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPluginManifestIds.size])
  const importInputRef = useRef<HTMLInputElement>(null)
  const [importConflict, setImportConflict] = useState<{ name: string; files: Record<string, string>; pluginId: string } | null>(null)

  useEffect(() => {
    refreshPluginList()
  }, [refreshPluginList])

  // Split plugins by scope
  const warehousePlugins = useMemo(
    () => pluginList.filter(p => p.manifest.scope === 'warehouse'),
    [pluginList],
  )
  const labPlugins = useMemo(
    () => pluginList.filter(p => (p.manifest.scope ?? 'lab') === 'lab'),
    [pluginList],
  )

  // Export a plugin as ZIP
  const handleExport = useCallback(async (pluginId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const storage = getStorage()
    const userPlugin = await storage.userPlugins.getById(pluginId)
    if (!userPlugin) return

    const zip = new JSZip()
    for (const [filename, content] of Object.entries(userPlugin.files)) {
      zip.file(filename, content)
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // Use plugin name from manifest if available
    let name = pluginId
    try {
      const m = JSON.parse(userPlugin.files['plugin.json'] ?? '{}')
      name = m.id ?? pluginId
    } catch { /* use pluginId */ }
    a.download = `${name}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }, [])

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
    await getStorage().userPlugins.create({ id, files: updatedFiles })
    await refreshPluginList()
  }, [refreshPluginList])

  // If editing a plugin, show the editor instead of the list
  if (editingPluginId) {
    return <PluginEditor />
  }

  const renderPluginGrid = (plugins: PluginListItem[]) => (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            lang={lang}
            onOpen={openPlugin}
            onExport={handleExport}
            onDuplicate={duplicatePlugin}
            onDelete={setDeleteId}
            t={t}
          />
        ))}
      </div>
      {plugins.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Puzzle size={32} className="text-muted-foreground/30" />
          <p className="mt-2 text-sm text-muted-foreground">{t('plugins.no_plugins')}</p>
        </div>
      )}
    </>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('plugins.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('plugins.description')}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs"
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
            <Button size="sm" variant="outline" onClick={() => setShowAddDefaultDialog(true)} className="gap-1 text-xs">
              <Puzzle size={14} />
              {t('plugins.add_default')}
            </Button>
          )}
          <Button size="sm" onClick={() => { setNewPluginName(''); setNewPluginEntityId(''); setCreateScope(activeTab === 'warehouse' ? 'warehouse' : 'lab'); setShowCreateDialog(true) }} className="gap-1 text-xs">
            <Plus size={14} />
            {t('plugins.new_plugin')}
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
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

      {/* Create plugin dialog */}
      <Dialog open={showCreateDialog} onOpenChange={(open) => { if (!open) setShowCreateDialog(false) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('plugins.create_title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>{t('plugins.scope')}</Label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCreateScope('warehouse')}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs transition-colors',
                    createScope === 'warehouse'
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  {t('plugins.scope_warehouse')}
                </button>
                <button
                  type="button"
                  onClick={() => setCreateScope('lab')}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs transition-colors',
                    createScope === 'lab'
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  {t('plugins.scope_lab')}
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('plugins.create_name_label')}</Label>
              <Input
                value={newPluginName}
                onChange={(e) => setNewPluginName(e.target.value)}
                placeholder={t('plugins.create_name_placeholder')}
                autoFocus
              />
              {newPluginName.trim() && pluginList.some(p => p.manifest.name.en.toLowerCase() === newPluginName.trim().toLowerCase()) && (
                <p className="text-xs text-destructive">{t('common.name_already_exists')}</p>
              )}
            </div>
            <EntityIdField
              name={newPluginName}
              value={newPluginEntityId}
              onChange={setNewPluginEntityId}
              existingIds={existingPluginIds}
              htmlId="plugin-entity-id"
              placeholder="my-plugin"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => { createPlugin(newPluginName, createScope, newPluginEntityId || undefined); setShowCreateDialog(false) }}
              disabled={!newPluginName.trim() || !isEntityIdValid(newPluginEntityId, existingPluginIds) || pluginList.some(p => p.manifest.name.en.toLowerCase() === newPluginName.trim().toLowerCase())}
            >
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add default plugin dialog */}
      <Dialog open={showAddDefaultDialog} onOpenChange={setShowAddDefaultDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('plugins.add_default')}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-1.5 overflow-auto py-2">
            {availableBuiltins.map(manifest => {
              const Icon = getIcon(manifest.icon)
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
                  <Icon size={18} className={cn('shrink-0', getIconColorProps(manifest.iconColor).className)} style={getIconColorProps(manifest.iconColor).style} />
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
