import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BadgeEditor } from '@/components/ui/badge-editor'
import { VersionField } from '@/components/ui/version-field'
import { useTallestPanel } from '@/hooks/use-tallest-panel'
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
import type { BadgeColor } from '@/types'
import type { PluginBadge, PluginFormFields } from '@/types/plugin'

const EMPTY_FIELDS: PluginFormFields = {
  name: '', description: '', scope: 'lab', languages: ['python'], icon: 'Puzzle',
  iconColor: 'blue', badges: [], pythonDeps: [], rDeps: [], version: '0.1.0', catalogVisibility: undefined,
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
  const { containerProps, measuredPanelProps } = useTallestPanel()
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

  /** Badges already used by the other plugins, offered as suggestions. */
  const badgeSuggestions = useMemo(
    () => pluginList.filter((p) => p.id !== targetId).flatMap((p) => p.manifest.badges ?? []),
    [pluginList, targetId],
  )

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
        version: (m.version as string) ?? '0.1.0',
        catalogVisibility: m.catalogVisibility as PluginFormFields['catalogVisibility'],
      })
    } else {
      setFields({ ...EMPTY_FIELDS, scope })
    }
    setEntityId(mode === 'edit' ? (targetItem?.entityId ?? '') : '')
  }, [open, mode, scope, language, pluginId, targetItem?.entityId])

  const set = useCallback(<K extends keyof PluginFormFields>(key: K, value: PluginFormFields[K]) => {
    setFields((f) => ({ ...f, [key]: value }))
  }, [])

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
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={mode === 'create' ? t('plugins.create_title') : t('plugins.settings_title')}
      onConfirm={handleSubmit}
      confirmLabel={mode === 'create' ? t('common.create') : t('common.save')}
      confirmDisabled={!canSubmit}
    >
        <Tabs defaultValue="general" className="flex flex-col gap-4">
          <TabsList className="w-full">
            <TabsTrigger value="general" className="flex-1">{t('plugins.tab_general')}</TabsTrigger>
            {!isSystemPlugin && (
              <TabsTrigger value="metadata" className="flex-1">{t('plugins.tab_metadata')}</TabsTrigger>
            )}
          </TabsList>

          {/* Holds the tallest panel's height so switching tabs doesn't move the
              triggers out from under the pointer. */}
          <div className="relative" {...containerProps}>
          <div {...measuredPanelProps('general')}>

          {/* --- General --- */}
          <TabsContent forceMount value="general" className="mt-0 max-h-[60vh] overflow-y-auto data-[state=inactive]:pointer-events-none data-[state=inactive]:invisible data-[state=inactive]:absolute data-[state=inactive]:inset-x-0 data-[state=inactive]:top-0">
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

              <EntityIdField
                name={fields.name}
                value={entityId}
                onChange={setEntityId}
                existingIds={existingIds}
                htmlId="plugin-entity-id"
                placeholder="my-plugin"
                required
                readOnly={mode === 'edit'}
              />

              <div className="grid gap-2">
                <Label htmlFor="plugin-desc">{t('common.description')}</Label>
                <Input
                  id="plugin-desc"
                  value={fields.description}
                  onChange={(e) => set('description', e.target.value)}
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
                  <BadgeColorButton value={fields.iconColor ?? 'blue'} onChange={(c) => set('iconColor', c)} />
                  <IconPicker
                    value={fields.icon}
                    onChange={(name) => set('icon', name)}
                    iconColor={iconColorCustom ? (fields.iconColor as string) : undefined}
                  />
                </div>
              </div>

            </div>
          </TabsContent>

          {/* --- Metadata --- */}
          {!isSystemPlugin && (
            <TabsContent forceMount value="metadata" className="mt-0 max-h-[60vh] overflow-y-auto data-[state=inactive]:pointer-events-none data-[state=inactive]:invisible data-[state=inactive]:absolute data-[state=inactive]:inset-x-0 data-[state=inactive]:top-0">
              <div className="grid gap-4 p-1">
                <BadgeEditor
                  value={fields.badges}
                  onChange={(next) => set('badges', next)}
                  suggestions={badgeSuggestions}
                  label={t('plugins.badges')}
                />
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

                <VersionField value={fields.version} onChange={(v) => set('version', v)} />

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
          </div>
          </div>
        </Tabs>
    </DialogShell>
  )
}
