import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DialogShell } from '@/components/ui/dialog-shell'
import { DatabaseSelect } from '@/components/ui/database-select'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { RequiredMark } from '@/components/ui/required-mark'
import { localized, setLocalized } from '@/lib/localized'
import { useAppStore, stampAuthored, stampLineage } from '@/stores/app-store'
import { AuthoringFields, type AuthoringValue } from '@/components/ui/authoring-fields'
import { BadgeEditor } from '@/components/ui/badge-editor'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { EntityDialogTabs } from '@/components/ui/entity-dialog-tabs'
import { VersionField } from '@/components/ui/version-field'
import { useBadgeSuggestions } from '@/hooks/use-badge-suggestions'
import { useSaveForm } from '@/hooks/use-save-form'
import { buildPointer } from '@/lib/import-identity'
import { useDatabaseOptions } from '@/hooks/use-database-options'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { getDefaultDimensions } from '@/types'
import type { DataCatalog, ProjectBadge } from '@/types'

/** The tabs this dialog can be opened straight at. */
type MainTab = 'general' | 'source' | 'metadata' | 'attribution'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingCatalog?: DataCatalog | null
  onCreated?: (catalogId: string) => void
  /** Tab to land on. Lets the overview's Source card open straight at it. */
  initialTab?: MainTab
}

export function CreateCatalogDialog({ open, onOpenChange, editingCatalog, onCreated, initialTab }: Props) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const { activeWorkspaceId } = useWorkspaceStore()
  const { createCatalog, updateCatalog } = useCatalogStore()
  const dbSources = useDatabaseOptions(activeWorkspaceId)

  const [name, setName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [description, setDescription] = useState('')
  const [dataSourceId, setDataSourceId] = useState('')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [version, setVersion] = useState('0.1.0')
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})
  const [mainTab, setMainTab] = useState<MainTab>('general')

  const isEdit = !!editingCatalog
  const { catalogs } = useCatalogStore()
  const existingIds = catalogs.map(c => c.entityId).filter((id): id is string => !!id)
  const badgeCategories = useBadgeCategories()
  const badgeSuggestions = useBadgeSuggestions(catalogs, activeWorkspaceId, editingCatalog?.id)

  useEffect(() => {
    if (editingCatalog) {
      setName(localized(editingCatalog.name, language))
      setEntityId(editingCatalog.entityId ?? '')
      setDescription(localized(editingCatalog.description, language))
      setDataSourceId(editingCatalog.dataSourceId)
      setBadges(editingCatalog.badges ?? [])
      setVersion(editingCatalog.version ?? '0.1.0')
      setAuthoring({})
      setMainTab(initialTab ?? 'general')
    } else {
      setName('')
      setEntityId('')
      setDescription('')
      setDataSourceId('')
      setBadges([])
      setVersion('0.1.0')
      setAuthoring({})
      setMainTab(initialTab ?? 'general')
    }
  }, [editingCatalog, open, initialTab])

  const canSubmit = !!name.trim() && (isEdit || isEntityIdValid(entityId, existingIds))

  const handleSubmit = async () => {
    if (!canSubmit || !activeWorkspaceId) return

    if (isEdit && editingCatalog) {
      await updateCatalog(editingCatalog.id, {
        name: setLocalized(editingCatalog.name, language, name.trim()),
        description: setLocalized(editingCatalog.description, language, description.trim()),
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
      await createCatalog({
        id,
        entityId: entityId || undefined,
        workspaceId: activeWorkspaceId,
        name: setLocalized(undefined, language, name.trim()),
        description: setLocalized(undefined, language, description.trim()),
        dataSourceId,
        dataSourceRef: buildPointer(dbSources, dataSourceId),
        badges,
        dimensions: getDefaultDimensions(),
        periodConfig: { granularity: 'month', serviceLevel: 'visit_detail' },
        anonymization: { threshold: 10, mode: 'replace' },
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
  }

  // Editing greys Save until something actually changed (and the shell then says
  // Close); creating keeps the "filled in enough" rule. Badges compare as JSON —
  // a fresh array each render would read as dirty on every keystroke.
  const { canSaveNow } = useSaveForm({
    current: { name: name.trim(), description: description.trim(), dataSourceId, version: version.trim(), badges: JSON.stringify(badges), authoring: JSON.stringify(authoring) },
    baseline: {
      name: localized(editingCatalog?.name, language),
      description: localized(editingCatalog?.description, language),
      dataSourceId: editingCatalog?.dataSourceId ?? '',
      version: editingCatalog?.version ?? '0.1.0',
      badges: JSON.stringify(editingCatalog?.badges ?? []),
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
      title={isEdit ? t('data_catalog.edit_title') : t('data_catalog.create_title')}
      onConfirm={handleSubmit}
      confirmLabel={isEdit ? t('common.save') : t('common.create')}
      confirmDisabled={isEdit ? !canSaveNow : !canSubmit}
      dirtyTracked={isEdit}
    >
      <EntityDialogTabs
        value={mainTab}
        onValueChange={(v) => setMainTab(v as MainTab)}
        general={
          <>
            <div className="space-y-2">
              <Label>{t('data_catalog.name')}<RequiredMark /></Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('data_catalog.name_placeholder')}
                autoFocus
              />
            </div>
            <EntityIdField
              name={name}
              value={entityId}
              onChange={setEntityId}
              existingIds={existingIds}
              htmlId="catalog-id"
              placeholder="my-catalog"
              required
              readOnly={isEdit}
            />
            <div className="space-y-2">
              <Label>{t('data_catalog.field_description')}</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('data_catalog.field_description_placeholder')}
              />
            </div>
          </>
        }
        extraTabs={[{
          value: 'source',
          label: t('data_catalog.tab_source'),
          content: (
            <div className="space-y-2">
              <Label>{t('data_catalog.select_database')}</Label>
              <DatabaseSelect
                workspaceId={activeWorkspaceId}
                value={dataSourceId}
                onChange={setDataSourceId}
                placeholder={t('data_catalog.select_database')}
              />
            </div>
          ),
        }]}
        metadata={
          <>
            <BadgeEditor value={badges} onChange={setBadges} categories={badgeCategories} suggestions={badgeSuggestions} />
            <VersionField value={version} onChange={setVersion} />
          </>
        }
        attribution={
          isEdit && editingCatalog ? (
            <AuthoringFields
              value={{
                createdById: 'createdById' in authoring ? authoring.createdById : editingCatalog.createdById,
                createdBy: authoring.createdBy ?? editingCatalog.createdBy,
                createdByDetails: authoring.createdByDetails ?? editingCatalog.createdByDetails,
                organization: authoring.organization ?? editingCatalog.organization,
              }}
              onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
            />
          ) : undefined
        }
      />
    </DialogShell>
  )
}
