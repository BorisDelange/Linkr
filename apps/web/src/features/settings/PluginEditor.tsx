import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import { ArrowLeft, Save, Copy, Trash2, X, ChevronLeft, ChevronRight, Tag, Plus, Building2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { cn } from '@/lib/utils'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { IconPicker } from '@/components/ui/icon-picker'
import { PluginFileList } from './PluginFileList'
import { PluginTestPanel } from './PluginTestPanel'
import { Textarea } from '@/components/ui/textarea'
import type { PresetBadgeColor, BadgeColor, CatalogVisibility, ChangelogEntry, LocalizedString } from '@/types'
import type { PluginBadge } from '@/types/analysis-plugin'

const PRESET_COLORS: { value: PresetBadgeColor; swatch: string }[] = [
  { value: 'red', swatch: 'bg-red-400' },
  { value: 'blue', swatch: 'bg-blue-400' },
  { value: 'green', swatch: 'bg-green-400' },
  { value: 'violet', swatch: 'bg-violet-400' },
  { value: 'amber', swatch: 'bg-amber-400' },
  { value: 'rose', swatch: 'bg-rose-400' },
  { value: 'cyan', swatch: 'bg-cyan-400' },
  { value: 'slate', swatch: 'bg-slate-400' },
]

function isCustomColor(color: BadgeColor): boolean {
  return !PRESET_COLORS.some((pc) => pc.value === color)
}

const languageFromFilename = (filename: string): string => {
  if (filename.endsWith('.json')) return 'json'
  if (filename.endsWith('.py') || filename.endsWith('.py.template')) return 'python'
  if (filename.endsWith('.R') || filename.endsWith('.R.template')) return 'r'
  if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return 'typescript'
  if (filename.endsWith('.js') || filename.endsWith('.jsx')) return 'javascript'
  if (filename.endsWith('.md')) return 'markdown'
  return 'plaintext'
}

export function PluginEditor() {
  const { t, i18n } = useTranslation()
  const {
    editingPluginId,
    isBuiltIn,
    files,
    openFiles,
    activeFile,
    isDirty,
    originalFiles,
    closeEditor,
    savePlugin,
    duplicatePlugin,
    deletePlugin,
    openFile,
    closeFile,
    updateFileContent,
    reorderOpenFiles,
  } = usePluginEditorStore()

  const [explorerVisible, setExplorerVisible] = useState(true)

  // --- Drag reorder state ---
  const [dragFile, setDragFile] = useState<string | null>(null)
  const [dropInsert, setDropInsert] = useState<{ name: string; side: 'left' | 'right' } | null>(null)

  // --- Tab scroll with arrows ---
  const tabScrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateTabScroll = useCallback(() => {
    const el = tabScrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateTabScroll()
    const el = tabScrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateTabScroll)
    const ro = new ResizeObserver(updateTabScroll)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateTabScroll)
      ro.disconnect()
    }
  }, [updateTabScroll, openFiles.length])

  const scrollTabs = useCallback((dir: 'left' | 'right') => {
    const el = tabScrollRef.current
    if (!el) return
    el.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' })
  }, [])

  const handleSave = useCallback(() => {
    savePlugin()
  }, [savePlugin])

  const handleDuplicate = useCallback(() => {
    if (editingPluginId) duplicatePlugin(editingPluginId)
  }, [editingPluginId, duplicatePlugin])

  const handleDelete = useCallback(() => {
    if (editingPluginId) deletePlugin(editingPluginId)
  }, [editingPluginId, deletePlugin])

  // Parse manifest
  const manifest = useMemo(() => {
    try {
      return JSON.parse(files['plugin.json'] ?? '{}')
    } catch { return {} }
  }, [files])

  const pluginName = manifest.name?.en ?? manifest.id ?? editingPluginId ?? ''
  const pluginVersion = manifest.version ?? '1.0.0'
  const pluginIcon: string = manifest.icon ?? 'Puzzle'
  const pluginIconColor: BadgeColor | undefined = manifest.iconColor
  const pluginBadges: PluginBadge[] = manifest.badges ?? []
  const pluginCatalogVisibility: CatalogVisibility | undefined = manifest.catalogVisibility
  const pluginContentHash: string | undefined = manifest.contentHash
  const pluginOrigin = manifest.origin as { pluginId: string; organizationId?: string } | undefined
  const pluginChangelog: ChangelogEntry[] = manifest.changelog ?? []

  // Helper to update a field in plugin.json
  const updateManifestField = useCallback((key: string, value: unknown) => {
    try {
      const m = JSON.parse(files['plugin.json'] ?? '{}')
      m[key] = value
      updateFileContent('plugin.json', JSON.stringify(m, null, 2))
    } catch { /* invalid json, skip */ }
  }, [files, updateFileContent])

  // Badge management
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')

  const handleAddBadge = useCallback(() => {
    const label = newBadgeLabel.trim()
    if (!label) return
    const badge: PluginBadge = { id: `b-${Date.now()}`, label, color: newBadgeColor }
    updateManifestField('badges', [...pluginBadges, badge])
    setNewBadgeLabel('')
  }, [newBadgeLabel, newBadgeColor, pluginBadges, updateManifestField])

  const handleRemoveBadge = useCallback((id: string) => {
    updateManifestField('badges', pluginBadges.filter(b => b.id !== id))
  }, [pluginBadges, updateManifestField])

  // Resolve workspace organization (read-only for plugin)
  const { activeWorkspaceId, _workspacesRaw } = useWorkspaceStore()
  const { getOrganization } = useOrganizationStore()
  const workspaceOrg = useMemo(() => {
    const ws = _workspacesRaw.find((w) => w.id === activeWorkspaceId)
    if (!ws) return undefined
    if (ws.organizationId) return getOrganization(ws.organizationId)
    // Legacy fallback
    return ws.organization ? { ...ws.organization, id: '', createdAt: '', updatedAt: '' } : undefined
  }, [activeWorkspaceId, _workspacesRaw, getOrganization])

  // Changelog state
  const [newChangelogVersion, setNewChangelogVersion] = useState('')
  const [newChangelogNotes, setNewChangelogNotes] = useState('')

  const handleAddChangelog = useCallback(() => {
    const version = newChangelogVersion.trim()
    const notes = newChangelogNotes.trim()
    if (!version || !notes) return
    const lang = (i18n.language ?? 'en') as string
    const entry: ChangelogEntry = {
      version,
      contentHash: pluginContentHash,
      date: new Date().toISOString().slice(0, 10),
      notes: { [lang]: notes } as LocalizedString,
    }
    updateManifestField('changelog', [...pluginChangelog, entry])
    setNewChangelogVersion('')
    setNewChangelogNotes('')
  }, [newChangelogVersion, newChangelogNotes, pluginContentHash, pluginChangelog, updateManifestField, i18n.language])

  const handleRemoveChangelog = useCallback((index: number) => {
    updateManifestField('changelog', pluginChangelog.filter((_, i) => i !== index))
  }, [pluginChangelog, updateManifestField])

  const activeContent = activeFile ? files[activeFile] ?? '' : ''
  const activeLanguage = activeFile ? languageFromFilename(activeFile) : 'plaintext'

  // Check if a specific file is dirty (content differs from original)
  const isFileDirtyFn = (filename: string) => {
    return files[filename] !== originalFiles[filename]
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="sm" onClick={closeEditor} className="gap-1 text-xs">
          <ArrowLeft size={14} />
          {t('plugins.back_to_list')}
        </Button>
        <span className="text-sm font-medium truncate">{pluginName}</span>
        <span className="text-[10px] text-muted-foreground">v{pluginVersion}</span>
        {isBuiltIn && (
          <Badge variant="outline" className="text-[10px]">
            {t('plugins.built_in')}
          </Badge>
        )}
        {pluginBadges.map((badge) => (
          <span
            key={badge.id}
            className={cn('shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium leading-none', getBadgeClasses(badge.color))}
            style={getBadgeStyle(badge.color)}
          >
            {badge.label}
          </span>
        ))}
        {isDirty && (
          <Badge variant="secondary" className="text-[10px]">
            {t('plugins.unsaved_changes')}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!isBuiltIn && (
            <Button size="sm" onClick={handleSave} disabled={!isDirty} className="gap-1 text-xs">
              <Save size={12} />
              {t('plugins.save')}
            </Button>
          )}
          {!isBuiltIn && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1 text-xs">
                  <Tag size={12} />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[340px] space-y-4">
                {/* Icon */}
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('plugins.icon')}</Label>
                  <IconPicker
                    value={pluginIcon}
                    onChange={(name) => updateManifestField('icon', name)}
                    iconColor={pluginIconColor && !PRESET_COLORS.some(c => c.value === pluginIconColor) ? pluginIconColor : undefined}
                  />
                </div>
                {/* Icon color */}
                <div className="space-y-2">
                  <Label className="text-xs">{t('plugins.icon_color')}</Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* None / default */}
                    <button
                      type="button"
                      onClick={() => updateManifestField('iconColor', undefined)}
                      className={cn(
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[8px] font-medium ring-offset-background transition-all',
                        !pluginIconColor
                          ? 'border-foreground/40 ring-2 ring-ring ring-offset-2'
                          : 'border-muted-foreground/30 hover:ring-1 hover:ring-ring hover:ring-offset-1',
                      )}
                    >
                      <X size={10} className="text-muted-foreground" />
                    </button>
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => updateManifestField('iconColor', c.value)}
                        className={cn(
                          'h-6 w-6 shrink-0 rounded-full ring-offset-background transition-all',
                          c.swatch,
                          pluginIconColor === c.value
                            ? 'ring-2 ring-ring ring-offset-2'
                            : 'hover:ring-1 hover:ring-ring hover:ring-offset-1',
                        )}
                      />
                    ))}
                    <div className="relative shrink-0">
                      <input
                        type="color"
                        value={pluginIconColor && isCustomColor(pluginIconColor) ? pluginIconColor : '#6366f1'}
                        onChange={(e) => updateManifestField('iconColor', e.target.value)}
                        className="absolute inset-0 h-6 w-6 cursor-pointer opacity-0"
                      />
                      <div
                        className={cn(
                          'flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/40 text-muted-foreground/60 ring-offset-background transition-all',
                          pluginIconColor && isCustomColor(pluginIconColor)
                            ? 'ring-2 ring-ring ring-offset-2'
                            : 'hover:border-muted-foreground/60',
                        )}
                        style={pluginIconColor && isCustomColor(pluginIconColor) ? { backgroundColor: pluginIconColor, borderStyle: 'solid', borderColor: pluginIconColor } : undefined}
                      >
                        {!(pluginIconColor && isCustomColor(pluginIconColor)) && <Plus size={10} />}
                      </div>
                    </div>
                  </div>
                </div>
                {/* Version */}
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('plugins.version')}</Label>
                  <Input
                    value={pluginVersion}
                    onChange={(e) => updateManifestField('version', e.target.value)}
                    className="h-7 text-xs"
                    placeholder="1.0.0"
                  />
                </div>
                {/* Badges */}
                <div className="space-y-2.5">
                  <Label className="text-xs">{t('plugins.badges')}</Label>
                  {pluginBadges.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {pluginBadges.map((badge) => (
                        <span
                          key={badge.id}
                          className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium', getBadgeClasses(badge.color))}
                          style={getBadgeStyle(badge.color)}
                        >
                          {badge.label}
                          <button
                            type="button"
                            onClick={() => handleRemoveBadge(badge.id)}
                            className="rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/20"
                          >
                            <X size={10} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <Input
                    value={newBadgeLabel}
                    onChange={(e) => setNewBadgeLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddBadge() }}
                    placeholder={t('plugins.badge_label_placeholder')}
                    className="h-7 text-xs"
                  />
                  <div className="flex items-center gap-1.5">
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => setNewBadgeColor(c.value)}
                        className={cn(
                          'h-6 w-6 rounded-full ring-offset-background transition-all',
                          c.swatch,
                          newBadgeColor === c.value
                            ? 'ring-2 ring-ring ring-offset-2'
                            : 'hover:ring-1 hover:ring-ring hover:ring-offset-1',
                        )}
                      />
                    ))}
                    <div className="relative">
                      <input
                        type="color"
                        value={isCustomColor(newBadgeColor) ? newBadgeColor : '#6366f1'}
                        onChange={(e) => setNewBadgeColor(e.target.value)}
                        className="absolute inset-0 h-6 w-6 cursor-pointer opacity-0"
                      />
                      <div
                        className={cn(
                          'flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/40 text-muted-foreground/60 ring-offset-background transition-all',
                          isCustomColor(newBadgeColor)
                            ? 'ring-2 ring-ring ring-offset-2'
                            : 'hover:border-muted-foreground/60',
                        )}
                        style={isCustomColor(newBadgeColor) ? { backgroundColor: newBadgeColor, borderStyle: 'solid', borderColor: newBadgeColor } : undefined}
                      >
                        {!isCustomColor(newBadgeColor) && <Plus size={10} />}
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleAddBadge}
                    disabled={!newBadgeLabel.trim()}
                    className="mt-0.5 h-7 gap-1 text-xs w-full"
                  >
                    <Plus size={12} />
                    {t('plugins.add_badge')}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
          {/* Publishing popover (organization, catalog visibility, traceability) */}
          {!isBuiltIn && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1 text-xs">
                  <Building2 size={12} />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[380px] max-h-[70vh] overflow-auto space-y-4">
                {/* Organization (inherited from workspace) */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">{t('organization.title')}</Label>
                  <p className="text-[10px] text-muted-foreground">{t('plugins.org_from_workspace')}</p>
                  {workspaceOrg ? (
                    <div className="space-y-1 rounded-md border border-border/50 bg-muted/30 px-2.5 py-2">
                      <p className="text-xs font-medium">{workspaceOrg.name}</p>
                      {(workspaceOrg.location || workspaceOrg.country) && (
                        <p className="text-[10px] text-muted-foreground">
                          {[workspaceOrg.location, workspaceOrg.country].filter(Boolean).join(', ')}
                        </p>
                      )}
                      {workspaceOrg.website && (
                        <p className="text-[10px] text-muted-foreground">{workspaceOrg.website}</p>
                      )}
                      {workspaceOrg.email && (
                        <p className="text-[10px] text-muted-foreground">{workspaceOrg.email}</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-[10px] text-muted-foreground italic">{t('plugins.no_workspace_org')}</p>
                  )}
                </div>

                {/* Catalog visibility */}
                <div className="space-y-2 border-t pt-3">
                  <Label className="text-xs font-medium">{t('catalog.visibility')}</Label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => updateManifestField('catalogVisibility', 'unlisted')}
                      className={cn(
                        'rounded-md border px-2.5 py-1 text-xs transition-colors',
                        pluginCatalogVisibility !== 'listed'
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:bg-accent',
                      )}
                    >
                      {t('catalog.unlisted')}
                    </button>
                    <button
                      type="button"
                      onClick={() => updateManifestField('catalogVisibility', 'listed')}
                      className={cn(
                        'rounded-md border px-2.5 py-1 text-xs transition-colors',
                        pluginCatalogVisibility === 'listed'
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:bg-accent',
                      )}
                    >
                      {t('catalog.listed')}
                    </button>
                  </div>
                </div>

                {/* Content hash & origin */}
                <div className="space-y-2 border-t pt-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium">{t('plugins.content_hash')}</Label>
                    <span className="font-mono text-[10px] text-muted-foreground select-all">
                      {pluginContentHash ? pluginContentHash.slice(0, 16) + '…' : t('plugins.content_hash_none')}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium">{t('plugins.origin_label')}</Label>
                    <span className="text-[10px] text-muted-foreground">
                      {pluginOrigin
                        ? `${pluginOrigin.pluginId}${pluginOrigin.organizationId ? ` (${pluginOrigin.organizationId})` : ''}`
                        : t('plugins.origin_none')}
                    </span>
                  </div>
                </div>

                {/* Changelog */}
                <div className="space-y-2 border-t pt-3">
                  <Label className="text-xs font-medium">{t('plugins.changelog')}</Label>
                  {pluginChangelog.length > 0 ? (
                    <div className="space-y-1.5 max-h-32 overflow-auto">
                      {pluginChangelog.map((entry, i) => {
                        const lang = i18n.language as string
                        const noteText = entry.notes[lang] ?? entry.notes.en ?? Object.values(entry.notes)[0] ?? ''
                        return (
                          <div key={i} className="group flex items-start gap-2 rounded border border-border/50 px-2 py-1.5">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] font-medium">{entry.version}</span>
                                <span className="text-[9px] text-muted-foreground">{entry.date}</span>
                              </div>
                              <p className="text-[10px] text-muted-foreground line-clamp-2">{noteText}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRemoveChangelog(i)}
                              className="mt-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                            >
                              <X size={10} className="text-muted-foreground" />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="text-[10px] text-muted-foreground">{t('plugins.no_changelog')}</p>
                  )}
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-3 gap-2">
                      <Input
                        value={newChangelogVersion}
                        onChange={(e) => setNewChangelogVersion(e.target.value)}
                        className="h-7 text-xs"
                        placeholder={t('plugins.changelog_version')}
                      />
                      <Textarea
                        value={newChangelogNotes}
                        onChange={(e) => setNewChangelogNotes(e.target.value)}
                        className="col-span-2 min-h-[28px] resize-none text-xs"
                        rows={1}
                        placeholder={t('plugins.changelog_notes')}
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleAddChangelog}
                      disabled={!newChangelogVersion.trim() || !newChangelogNotes.trim()}
                      className="h-7 gap-1 text-xs w-full"
                    >
                      <Plus size={12} />
                      {t('plugins.add_changelog_entry')}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          )}
          <Button variant="ghost" size="sm" onClick={handleDuplicate} className="gap-1 text-xs">
            <Copy size={12} />
            {t('plugins.duplicate')}
          </Button>
          {!isBuiltIn && (
            <Button variant="ghost" size="sm" onClick={handleDelete} className="gap-1 text-xs text-destructive hover:text-destructive">
              <Trash2 size={12} />
            </Button>
          )}
        </div>
      </div>

      {/* 3-panel layout */}
      <div className="min-h-0 flex-1">
        <Allotment>
          {/* File list */}
          <Allotment.Pane preferredSize={180} minSize={120} maxSize={300} visible={explorerVisible}>
            <PluginFileList onCollapse={() => setExplorerVisible(false)} />
          </Allotment.Pane>

          {/* Editor area */}
          <Allotment.Pane minSize={200}>
            <div className="flex h-full flex-col">
              {/* Tab bar with scroll arrows */}
              {openFiles.length > 0 && (
                <div className="flex items-center border-b bg-muted/30">
                  <button
                    type="button"
                    onClick={() => scrollTabs('left')}
                    disabled={!canScrollLeft}
                    className={cn(
                      'shrink-0 px-0.5 py-1.5 transition-colors',
                      canScrollLeft
                        ? 'text-muted-foreground hover:text-foreground'
                        : 'text-muted-foreground/25 cursor-default',
                    )}
                  >
                    <ChevronLeft size={12} />
                  </button>
                  <div
                    ref={tabScrollRef}
                    className="flex items-center overflow-x-auto scrollbar-none"
                  >
                    {openFiles.map((filename) => {
                      const isActive = activeFile === filename
                      const fileDirty = !isBuiltIn && isFileDirtyFn(filename)
                      return (
                        <button
                          key={filename}
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('plugin-tab', filename)
                            e.dataTransfer.effectAllowed = 'move'
                            setDragFile(filename)
                          }}
                          onDragOver={(e) => {
                            if (!e.dataTransfer.types.includes('plugin-tab')) return
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            const rect = e.currentTarget.getBoundingClientRect()
                            const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
                            setDropInsert({ name: filename, side })
                          }}
                          onDragLeave={() => setDropInsert(null)}
                          onDrop={(e) => {
                            e.preventDefault()
                            const side = dropInsert?.side ?? 'right'
                            setDropInsert(null)
                            setDragFile(null)
                            const draggedName = e.dataTransfer.getData('plugin-tab')
                            if (!draggedName || draggedName === filename) return
                            const fromIdx = openFiles.indexOf(draggedName)
                            let toIdx = openFiles.indexOf(filename)
                            if (side === 'right') toIdx++
                            if (fromIdx < toIdx) toIdx--
                            if (fromIdx !== -1 && toIdx >= 0 && fromIdx !== toIdx) {
                              reorderOpenFiles(fromIdx, toIdx)
                            }
                          }}
                          onDragEnd={() => { setDragFile(null); setDropInsert(null) }}
                          onClick={() => openFile(filename)}
                          className={cn(
                            'relative group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                            isActive
                              ? 'bg-background text-foreground'
                              : 'text-muted-foreground hover:bg-accent/50',
                            dragFile === filename && 'opacity-40',
                          )}
                        >
                          {dropInsert?.name === filename && dropInsert.side === 'left' && dragFile !== filename && (
                            <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
                          )}
                          {dropInsert?.name === filename && dropInsert.side === 'right' && dragFile !== filename && (
                            <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
                          )}
                          <span className="max-w-[140px] truncate" title={filename}>{filename}</span>
                          {fileDirty && (
                            <span className="ml-0.5 size-1.5 shrink-0 rounded-full bg-orange-400" />
                          )}
                          {!isBuiltIn && (
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => { e.stopPropagation(); closeFile(filename) }}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); closeFile(filename) } }}
                              className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                            >
                              <X size={10} />
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => scrollTabs('right')}
                    disabled={!canScrollRight}
                    className={cn(
                      'shrink-0 px-0.5 py-1.5 transition-colors',
                      canScrollRight
                        ? 'text-muted-foreground hover:text-foreground'
                        : 'text-muted-foreground/25 cursor-default',
                    )}
                  >
                    <ChevronRight size={12} />
                  </button>
                </div>
              )}

              {/* Monaco editor */}
              <div className="min-h-0 flex-1">
                {activeFile ? (
                  <CodeEditor
                    value={activeContent}
                    language={activeLanguage}
                    onChange={(val) => {
                      if (activeFile && val !== undefined) {
                        updateFileContent(activeFile, val)
                      }
                    }}
                    readOnly={isBuiltIn}
                    onSave={handleSave}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {t('plugins.select_file')}
                  </div>
                )}
              </div>
            </div>
          </Allotment.Pane>

          {/* Preview / Test panel */}
          <Allotment.Pane preferredSize={320} minSize={200}>
            <PluginTestPanel />
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}
