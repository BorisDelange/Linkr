import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DialogShell } from '@/components/ui/dialog-shell'
import { DatabaseSelect } from '@/components/ui/database-select'
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
import { useDqProfileStore } from '@/stores/dq-profile-store'
import type { DqProfile, ProjectBadge } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingProfile?: DqProfile | null
  onCreated?: (profileId: string) => void
}

export function CreateDqProfileDialog({ open, onOpenChange, editingProfile, onCreated }: Props) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const { activeWorkspaceId } = useWorkspaceStore()
  const { profiles, createProfile, updateProfile } = useDqProfileStore()
  const dbSources = useDatabaseOptions(activeWorkspaceId)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [entityId, setEntityId] = useState('')
  const [dataSourceId, setDataSourceId] = useState('')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [version, setVersion] = useState('0.1.0')
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})

  const isEdit = !!editingProfile
  const existingIds = profiles.map((p) => p.entityId).filter((id): id is string => !!id)
  const badgeCategories = useBadgeCategories()
  const badgeSuggestions = useBadgeSuggestions(profiles, activeWorkspaceId, editingProfile?.id)

  useEffect(() => {
    setName(localized(editingProfile?.name, language))
    setDescription(localized(editingProfile?.description, language))
    setEntityId(editingProfile?.entityId ?? '')
    setDataSourceId(editingProfile?.dataSourceId ?? '')
    setBadges(editingProfile?.badges ?? [])
    setVersion(editingProfile?.version ?? '0.1.0')
    setAuthoring({})
  }, [editingProfile, open]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async () => {
    if (!name.trim() || !dataSourceId || !activeWorkspaceId) return

    if (isEdit && editingProfile) {
      await updateProfile(editingProfile.id, {
        name: setLocalized(editingProfile.name, language, name.trim()),
        description: setLocalized(editingProfile.description, language, description.trim()),
        dataSourceId,
        dataSourceRef: buildPointer(dbSources, dataSourceId),
        badges,
        version: version.trim() || '0.1.0',
        ...authoring,
      })
      onOpenChange(false)
      return
    }
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    await createProfile({
      id,
      entityId: entityId || undefined,
      workspaceId: activeWorkspaceId,
      name: setLocalized(undefined, language, name.trim()),
      description: setLocalized(undefined, language, description.trim()),
      dataSourceId,
      dataSourceRef: buildPointer(dbSources, dataSourceId),
      sources: [],
      badges,
      status: 'draft',
      version: version.trim() || '0.1.0',
      ...stampAuthored(),
      ...stampLineage(),
      createdAt: now,
      updatedAt: now,
    })
    onOpenChange(false)
    onCreated?.(id)
  }

  const canSubmit = !!name.trim() && !!dataSourceId && (isEdit || isEntityIdValid(entityId, existingIds))

  // Editing greys Save until something actually changed (the shell then says Close).
  const { canSaveNow } = useSaveForm({
    current: { name: name.trim(), description: description.trim(), dataSourceId, version: version.trim(), badges: JSON.stringify(badges), authoring: JSON.stringify(authoring) },
    baseline: {
      name: localized(editingProfile?.name, language),
      description: localized(editingProfile?.description, language),
      dataSourceId: editingProfile?.dataSourceId ?? '',
      version: editingProfile?.version ?? '0.1.0',
      badges: JSON.stringify(editingProfile?.badges ?? []),
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
      title={isEdit ? t('data_quality.edit_profile_title') : t('data_quality.create_profile_title')}
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
                placeholder={t('data_quality.profile_name_placeholder')}
                autoFocus
              />
            </div>
            <EntityIdField
              name={name}
              value={entityId}
              onChange={setEntityId}
              existingIds={existingIds}
              htmlId="dq-profile-id"
              placeholder="my-quality-profile"
              required
              readOnly={isEdit}
            />
            <div className="space-y-2">
              <Label>{t('common.description')}</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{t('data_quality.rs_database')}<RequiredMark /></Label>
              <DatabaseSelect
                workspaceId={activeWorkspaceId}
                value={dataSourceId}
                onChange={setDataSourceId}
                placeholder={t('data_quality.select_database')}
              />
              <p className="text-xs text-muted-foreground">{t('data_quality.profile_database_hint')}</p>
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
          isEdit && editingProfile ? (
            <AuthoringFields
              value={{
                createdById: 'createdById' in authoring ? authoring.createdById : editingProfile.createdById,
                createdBy: authoring.createdBy ?? editingProfile.createdBy,
                createdByDetails: authoring.createdByDetails ?? editingProfile.createdByDetails,
                organization: authoring.organization ?? editingProfile.organization,
              }}
              onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
            />
          ) : undefined
        }
      />
    </DialogShell>
  )
}
