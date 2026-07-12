import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { IconPicker } from '@/components/ui/icon-picker'
import { BadgeColorButton } from '@/components/ui/badge-color-button'
import { RequiredMark } from '@/components/ui/required-mark'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { cn } from '@/lib/utils'
import { localized } from '@/lib/localized'
import { isCustomColor } from '@/lib/badge-colors'
import { useAppStore } from '@/stores/app-store'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { bumpVersion, type BumpType } from '@/lib/semver'
import type { BadgeColor } from '@/types'
import type { PluginBadge, PluginFormFields } from '@/types/plugin'

const EMPTY_FIELDS: PluginFormFields = {
  name: '', description: '', scope: 'lab', languages: ['python'], icon: 'Puzzle',
  iconColor: 'blue', badges: [], pythonDeps: [], rDeps: [], version: '1.0.0', catalogVisibility: undefined,
}

interface PluginSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 'create' builds a fresh plugin on submit; 'edit' updates an existing one. */
  mode: 'create' | 'edit'
  /** Scope for a newly created plugin — set by the active list tab, not editable here. */
  scope?: 'lab' | 'warehouse'
  /** Edit mode: the plugin (row) id to edit. Defaults to the currently open plugin. */
  pluginId?: string
}

export function PluginSettingsDialog({ open, onOpenChange, mode, scope = 'lab', pluginId }: PluginSettingsDialogProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const editingPluginId = usePluginEditorStore((s) => s.editingPluginId)
  const pluginList = usePluginEditorStore((s) => s.pluginList)
  const createPluginWithFields = usePluginEditorStore((s) => s.createPluginWithFields)
  const applyManifestFields = usePluginEditorStore((s) => s.applyManifestFields)
  const updatePluginMetadata = usePluginEditorStore((s) => s.updatePluginMetadata)
  const openIsSystem = usePluginEditorStore((s) => s.isSystemPlugin)

  // Target row for edit mode: explicit prop, else the currently open plugin.
  const targetId = pluginId ?? editingPluginId ?? undefined
  const targetItem = pluginList.find((p) => p.id === targetId)
  const isSystemPlugin = targetItem?.isSystemPlugin ?? openIsSystem

  const [fields, setFields] = useState<PluginFormFields>(EMPTY_FIELDS)
  const [entityId, setEntityId] = useState('')
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')

  // Existing ids/names for uniqueness checks (exclude the plugin being edited).
  const existingIds = pluginList
    .filter((p) => p.id !== targetId)
    .map((p) => p.entityId)
    .filter((id): id is string => !!id)
  const nameTaken = !!fields.name.trim() && pluginList.some(
    (p) => p.id !== targetId
      && localized(p.manifest.name, language).trim().toLowerCase() === fields.name.trim().toLowerCase(),
  )

  // Initialise the form once per open.
  useEffect(() => {
    if (!open) return
    if (mode === 'edit') {
      // Prefer the manifest from the list item (edit-by-id), else the open plugin's files.
      let m: Record<string, unknown> = {}
      const item = usePluginEditorStore.getState().pluginList.find((p) => p.id === (pluginId ?? usePluginEditorStore.getState().editingPluginId))
      if (item) m = item.manifest as unknown as Record<string, unknown>
      else { try { m = JSON.parse(usePluginEditorStore.getState().files['plugin.json'] ?? '{}') } catch { /* keep empty */ } }
      const deps = (m.dependencies ?? {}) as { python?: string[]; r?: string[] }
      setFields({
        name: localized(m.name as never, language),
        description: localized(m.description as never, language),
        scope: (m.scope as 'lab' | 'warehouse') ?? 'lab',
        languages: (m.languages as ('python' | 'r')[]) ?? ['python'],
        icon: (m.icon as string) ?? 'Puzzle',
        iconColor: (m.iconColor as BadgeColor) ?? 'blue',
        badges: (m.badges as PluginBadge[]) ?? [],
        pythonDeps: deps.python ?? [],
        rDeps: deps.r ?? [],
        version: (m.version as string) ?? '1.0.0',
        catalogVisibility: m.catalogVisibility as PluginFormFields['catalogVisibility'],
      })
    } else {
      setFields({ ...EMPTY_FIELDS, scope })
    }
    setEntityId('')
    setNewBadgeLabel('')
    setNewBadgeColor('blue')
  }, [open, mode, scope, language, pluginId])

  const set = useCallback(<K extends keyof PluginFormFields>(key: K, value: PluginFormFields[K]) => {
    setFields((f) => ({ ...f, [key]: value }))
  }, [])

  const handleAddBadge = useCallback(() => {
    const label = newBadgeLabel.trim()
    if (!label) return
    setFields((f) => ({ ...f, badges: [...f.badges, { id: `b-${Date.now()}`, label, color: newBadgeColor }] }))
    setNewBadgeLabel('')
  }, [newBadgeLabel, newBadgeColor])

  const canSubmit = !!fields.name.trim()
    && !nameTaken
    && (mode === 'edit' || isEntityIdValid(entityId, existingIds))

  const handleSubmit = async () => {
    if (!canSubmit) return
    if (mode === 'create') {
      await createPluginWithFields(fields, language, entityId || undefined)
    } else if (targetId) {
      await updatePluginMetadata(targetId, fields, language)
    } else {
      await applyManifestFields(fields, language)
    }
    onOpenChange(false)
  }

  const iconColorCustom = isCustomColor(fields.iconColor ?? 'blue')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('plugins.create_title') : t('plugins.settings_title')}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="general" className="flex flex-col gap-4">
          <TabsList className="w-full">
            <TabsTrigger value="general" className="flex-1">{t('plugins.tab_general')}</TabsTrigger>
            {!isSystemPlugin && (
              <TabsTrigger value="advanced" className="flex-1">{t('plugins.tab_advanced')}</TabsTrigger>
            )}
          </TabsList>

          {/* --- General --- */}
          <TabsContent value="general" className="mt-0 max-h-[60vh] overflow-y-auto">
            <div className="grid gap-4 p-1">
              <div className="grid gap-2">
                <Label htmlFor="plugin-name">{t('common.name')}<RequiredMark /></Label>
                <Input
                  id="plugin-name"
                  value={fields.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder={t('plugins.create_name_placeholder')}
                  autoFocus
                  aria-invalid={nameTaken}
                />
                {nameTaken && (
                  <p className="text-xs text-destructive">{t('common.name_already_exists')}</p>
                )}
              </div>

              {mode === 'create' && (
                <EntityIdField
                  name={fields.name}
                  value={entityId}
                  onChange={setEntityId}
                  existingIds={existingIds}
                  htmlId="plugin-entity-id"
                  placeholder="my-plugin"
                  required
                />
              )}

              <div className="grid gap-2">
                <Label htmlFor="plugin-desc">{t('common.description')}</Label>
                <Textarea
                  id="plugin-desc"
                  value={fields.description}
                  onChange={(e) => set('description', e.target.value)}
                  className="min-h-[64px] resize-none"
                  rows={3}
                />
              </div>

              {!isSystemPlugin && (
                <div className="grid gap-2">
                  <Label>{t('plugins.languages')}</Label>
                  <div className="flex items-center gap-4">
                    {(['python', 'r'] as const).map((l) => (
                      <label key={l} className="flex cursor-pointer items-center gap-2 text-sm">
                        <Checkbox
                          checked={fields.languages.includes(l)}
                          onCheckedChange={(v) => set('languages', v
                            ? [...new Set([...fields.languages, l])]
                            : fields.languages.filter((x) => x !== l))}
                        />
                        {l === 'python' ? 'Python' : 'R'}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Icon + colour — grouped side by side */}
              <div className="grid gap-2">
                <Label>{t('plugins.icon')}</Label>
                <div className="flex items-center gap-2">
                  <IconPicker
                    value={fields.icon}
                    onChange={(name) => set('icon', name)}
                    iconColor={iconColorCustom ? (fields.iconColor as string) : undefined}
                  />
                  <BadgeColorButton value={fields.iconColor ?? 'blue'} onChange={(c) => set('iconColor', c)} />
                </div>
              </div>

              {/* Badges */}
              <div className="grid gap-2">
                <Label>{t('plugins.badges')}</Label>
                {fields.badges.length > 0 && (
                  <div className="mb-1 flex flex-wrap gap-1.5">
                    {fields.badges.map((badge) => (
                      <span
                        key={badge.id}
                        className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium', getBadgeClasses(badge.color))}
                        style={getBadgeStyle(badge.color)}
                      >
                        {badge.label}
                        <button
                          type="button"
                          className="ml-0.5 opacity-60 hover:opacity-100"
                          onClick={() => set('badges', fields.badges.filter((b) => b.id !== badge.id))}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Input
                    value={newBadgeLabel}
                    onChange={(e) => setNewBadgeLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddBadge() } }}
                    placeholder={t('plugins.badge_label_placeholder')}
                    className="h-8 flex-1 text-xs"
                  />
                  <BadgeColorButton value={newBadgeColor} onChange={setNewBadgeColor} />
                  <Button type="button" variant="outline" size="sm" className="h-8 px-2" disabled={!newBadgeLabel.trim()} onClick={handleAddBadge}>
                    <Plus size={12} />
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* --- Advanced --- */}
          {!isSystemPlugin && (
            <TabsContent value="advanced" className="mt-0 max-h-[60vh] overflow-y-auto">
              <div className="grid gap-4 p-1">
                <div className="grid gap-2">
                  <Label>{t('plugins.dependencies')}</Label>
                  <div className="grid gap-1">
                    <span className="text-[10px] text-muted-foreground">{t('plugins.python_deps')}</span>
                    <Textarea
                      value={fields.pythonDeps.join('\n')}
                      onChange={(e) => set('pythonDeps', e.target.value.split('\n').filter(Boolean))}
                      placeholder="pandas&#10;numpy"
                      className="min-h-[56px] resize-none font-mono text-xs"
                      rows={2}
                    />
                  </div>
                  <div className="grid gap-1">
                    <span className="text-[10px] text-muted-foreground">{t('plugins.r_deps')}</span>
                    <Textarea
                      value={fields.rDeps.join('\n')}
                      onChange={(e) => set('rDeps', e.target.value.split('\n').filter(Boolean))}
                      placeholder="dplyr&#10;ggplot2"
                      className="min-h-[56px] resize-none font-mono text-xs"
                      rows={2}
                    />
                  </div>
                </div>

                <div className="grid gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label>{t('plugins.version')}</Label>
                    <Input
                      value={fields.version}
                      onChange={(e) => set('version', e.target.value)}
                      className="h-7 w-24 text-right font-mono text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(['patch', 'minor', 'major'] as BumpType[]).map((type) => (
                      <Button
                        key={type}
                        variant="outline"
                        size="sm"
                        onClick={() => set('version', bumpVersion(fields.version, type))}
                        className="h-auto flex-col gap-0 py-1.5"
                      >
                        <span className="font-medium">{t(`plugins.bump_${type}`)}</span>
                        <span className="text-[10px] text-muted-foreground">{bumpVersion(fields.version, type)}</span>
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label>{t('plugins.publishing_section')}</Label>
                  <div className="flex items-center gap-2">
                    {(['unlisted', 'listed'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => set('catalogVisibility', v)}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-xs transition-colors',
                          (fields.catalogVisibility === 'listed' ? 'listed' : 'unlisted') === v
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {t(`catalog.${v}`)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </TabsContent>
          )}
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {mode === 'create' ? t('common.create') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
