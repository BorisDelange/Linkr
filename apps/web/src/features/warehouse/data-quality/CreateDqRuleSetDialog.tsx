import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DialogShell } from '@/components/ui/dialog-shell'
import { DatabaseSelect } from '@/components/ui/database-select'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { RequiredMark } from '@/components/ui/required-mark'
import { localized, setLocalized } from '@/lib/localized'
import { buildPointer } from '@/lib/import-identity'
import { useAppStore, stampAuthored, stampLineage } from '@/stores/app-store'
import { AuthoringFields, type AuthoringValue } from '@/components/ui/authoring-fields'
import { BadgeEditor } from '@/components/ui/badge-editor'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { EntityDialogTabs } from '@/components/ui/entity-dialog-tabs'
import { VersionField } from '@/components/ui/version-field'
import { useBadgeSuggestions } from '@/hooks/use-badge-suggestions'
import { useSaveForm } from '@/hooks/use-save-form'
import { useDatabaseOptions } from '@/hooks/use-database-options'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDqStore } from '@/stores/dq-store'
import { useSchemaPresetStore } from '@/stores/schema-preset-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { checksFromTemplates, schemaCheckTemplates } from '@/lib/dq-templates'
import { findSourcePreset } from '@/features/projects/warehouse/databases/AddDatabaseDialog'
import type { CustomSchemaPreset, DqRuleSet, EntityRef, ProjectBadge } from '@/types'

const NO_SCHEMA = '__none__'

function presetPointer(preset: CustomSchemaPreset): EntityRef {
  return {
    ...(preset.lineageId ? { lineageId: preset.lineageId } : {}),
    entityId: preset.entityId,
    label: preset.mapping.presetLabel,
  }
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingRuleSet?: DqRuleSet | null
  onCreated?: (ruleSetId: string) => void
}

export function CreateDqRuleSetDialog({ open, onOpenChange, editingRuleSet, onCreated }: Props) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const { activeWorkspaceId } = useWorkspaceStore()
  const { createRuleSet, updateRuleSet, createCustomChecks } = useDqStore()
  const dbSources = useDatabaseOptions(activeWorkspaceId)
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const allPresets = useSchemaPresetStore((s) => s.presets)
  const presetsLoaded = useSchemaPresetStore((s) => s.loaded)
  const loadPresets = useSchemaPresetStore((s) => s.loadPresets)
  const presets = useMemo(
    () => allPresets.filter((p) => !activeWorkspaceId || p.workspaceId === activeWorkspaceId),
    [allPresets, activeWorkspaceId],
  )

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [entityId, setEntityId] = useState('')
  const [dataSourceId, setDataSourceId] = useState('')
  const [presetId, setPresetId] = useState(NO_SCHEMA)
  // Picking a database proposes its schema, until the user picks one themselves.
  const [presetTouched, setPresetTouched] = useState(false)
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [version, setVersion] = useState('0.1.0')
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})

  const isEdit = !!editingRuleSet
  const { dqRuleSets } = useDqStore()
  const existingIds = dqRuleSets.map(r => r.entityId).filter((id): id is string => !!id)
  const badgeCategories = useBadgeCategories()
  const badgeSuggestions = useBadgeSuggestions(dqRuleSets, activeWorkspaceId, editingRuleSet?.id)

  useEffect(() => {
    if (open && !presetsLoaded) void loadPresets(activeWorkspaceId ?? undefined)
  }, [open, presetsLoaded, loadPresets, activeWorkspaceId])

  useEffect(() => {
    setPresetId(NO_SCHEMA)
    setPresetTouched(false)
    if (editingRuleSet) {
      setName(localized(editingRuleSet.name, language))
      setDescription(localized(editingRuleSet.description, language))
      setEntityId(editingRuleSet.entityId ?? '')
      setDataSourceId(editingRuleSet.dataSourceId)
      setBadges(editingRuleSet.badges ?? [])
      setVersion(editingRuleSet.version ?? '0.1.0')
      setAuthoring({})
    } else {
      setName('')
      setDescription('')
      setEntityId('')
      setDataSourceId('')
      setBadges([])
      setVersion('0.1.0')
      setAuthoring({})
    }
  }, [editingRuleSet, open])

  const preset = presets.find((p) => p.id === presetId)
  const templates = useMemo(
    () => (preset ? schemaCheckTemplates(preset.mapping, (key, vars) => t(key, vars ?? {})) : []),
    [preset, t],
  )
  const templateCounts = useMemo(() => ({
    ddl: templates.filter((c) => c.origin === 'ddl').length,
    mapping: templates.filter((c) => c.origin === 'mapping').length,
  }), [templates])
  const editingPresetLabel = localized(editingRuleSet?.schemaPresetRef?.label, language)

  const handleDatabaseChange = (id: string) => {
    setDataSourceId(id)
    if (isEdit || presetTouched) return
    const source = dataSources.find((ds) => ds.id === id)
    const match = source ? findSourcePreset(source, presets) : undefined
    if (match) setPresetId(match.id)
  }

  const handleSubmit = async () => {
    if (!name.trim() || !activeWorkspaceId) return

    if (isEdit && editingRuleSet) {
      await updateRuleSet(editingRuleSet.id, {
        name: setLocalized(editingRuleSet.name, language, name.trim()),
        description: setLocalized(editingRuleSet.description, language, description.trim()),
        dataSourceId,
        dataSourceRef: buildPointer(dbSources, dataSourceId),
        badges,
        version: version.trim() || '0.1.0',
        ...authoring,
      })
      onOpenChange(false)
    } else {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      await createRuleSet({
        id,
        entityId: entityId || undefined,
        workspaceId: activeWorkspaceId,
        name: setLocalized(undefined, language, name.trim()),
        description: setLocalized(undefined, language, description.trim()),
        dataSourceId,
        dataSourceRef: buildPointer(dbSources, dataSourceId),
        ...(preset ? { schemaPresetRef: presetPointer(preset) } : {}),
        badges,
        status: 'draft',
        version: version.trim() || '0.1.0',
        ...stampAuthored(),
        ...stampLineage(),
        createdAt: now,
        updatedAt: now,
      })
      if (templates.length) await createCustomChecks(checksFromTemplates(id, templates))
      onOpenChange(false)
      onCreated?.(id)
    }
  }

  const canSubmit = !!name.trim() && (isEdit || isEntityIdValid(entityId, existingIds))

  // Editing greys Save until something actually changed (and the shell then says
  // Close); creating keeps the "filled in enough" rule. Badges compare as JSON —
  // a fresh array each render would read as dirty on every keystroke.
  const { canSaveNow } = useSaveForm({
    current: { name: name.trim(), description: description.trim(), dataSourceId, version: version.trim(), badges: JSON.stringify(badges), authoring: JSON.stringify(authoring) },
    baseline: {
      name: localized(editingRuleSet?.name, language),
      description: localized(editingRuleSet?.description, language),
      dataSourceId: editingRuleSet?.dataSourceId ?? '',
      version: editingRuleSet?.version ?? '0.1.0',
      badges: JSON.stringify(editingRuleSet?.badges ?? []),
      authoring: '{}',
    },
    onSave: handleSubmit,
    canSave: canSubmit,
    enabled: open && isEdit,
  })

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? t('data_quality.edit_rs_title') : t('data_quality.create_rs_title')}
      onConfirm={handleSubmit}
      confirmLabel={isEdit ? t('common.save') : t('common.create')}
      confirmDisabled={isEdit ? !canSaveNow : !canSubmit}
      dirtyTracked={isEdit}
    >
      <EntityDialogTabs
        general={
          <>
            <div className="space-y-2">
              <Label>{t('data_quality.rs_name')}<RequiredMark /></Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('data_quality.rs_name_placeholder')}
                autoFocus
              />
            </div>
            <EntityIdField
              name={name}
              value={entityId}
              onChange={setEntityId}
              existingIds={existingIds}
              htmlId="dq-ruleset-id"
              placeholder="my-rule-set"
              required
              readOnly={isEdit}
            />
            <div className="space-y-2">
              <Label>{t('common.description')}</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('data_quality.rs_database')}</Label>
              <DatabaseSelect
                workspaceId={activeWorkspaceId}
                value={dataSourceId}
                onChange={handleDatabaseChange}
                placeholder={t('data_quality.select_database')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('data_quality.rs_schema')}</Label>
              {isEdit ? (
                <Input value={editingPresetLabel || t('data_quality.rs_schema_none')} disabled />
              ) : (
                <Select value={presetId} onValueChange={(v) => { setPresetId(v); setPresetTouched(true) }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SCHEMA}>{t('data_quality.rs_schema_none')}</SelectItem>
                    {presets.length > 0 && <SelectSeparator />}
                    {presets.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {localized(p.mapping.presetLabel, language) || p.entityId}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">
                {isEdit
                  ? t('data_quality.rs_schema_edit_hint')
                  : preset
                    ? t('data_quality.rs_schema_hint', { count: templates.length, ddl: templateCounts.ddl, mapping: templateCounts.mapping })
                    : t('data_quality.rs_schema_none_hint')}
              </p>
            </div>
          </>
        }
        metadata={
          <>
            <BadgeEditor value={badges} onChange={setBadges} categories={badgeCategories} suggestions={badgeSuggestions} />
            <VersionField value={version} onChange={setVersion} />
          </>
        }
        attribution={
          isEdit && editingRuleSet ? (
            <AuthoringFields
              value={{
                createdById: 'createdById' in authoring ? authoring.createdById : editingRuleSet.createdById,
                createdBy: authoring.createdBy ?? editingRuleSet.createdBy,
                createdByDetails: authoring.createdByDetails ?? editingRuleSet.createdByDetails,
                organization: authoring.organization ?? editingRuleSet.organization,
              }}
              onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
            />
          ) : undefined
        }
      />
    </DialogShell>
  )
}
