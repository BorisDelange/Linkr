import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { RequiredMark } from '@/components/ui/required-mark'
import { localized, setLocalized } from '@/lib/localized'
import { useAppStore, stampAuthored, stampLineage } from '@/stores/app-store'
import { AuthoringFields, type AuthoringValue } from '@/components/ui/authoring-fields'
import { BadgeEditor } from '@/components/ui/badge-editor'
import { VersionField } from '@/components/ui/version-field'
import { useBadgeSuggestions } from '@/hooks/use-badge-suggestions'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { getDefaultDimensions } from '@/types'
import type { DataCatalog, ProjectBadge } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingCatalog?: DataCatalog | null
  onCreated?: (catalogId: string) => void
}

export function CreateCatalogDialog({ open, onOpenChange, editingCatalog, onCreated }: Props) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const { activeWorkspaceId } = useWorkspaceStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { createCatalog, updateCatalog } = useCatalogStore()
  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database' && !ds.isVocabularyReference)

  const [name, setName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [description, setDescription] = useState('')
  const [dataSourceId, setDataSourceId] = useState('')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [version, setVersion] = useState('0.1.0')
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})

  const isEdit = !!editingCatalog
  const { catalogs } = useCatalogStore()
  const existingIds = catalogs.map(c => c.entityId).filter((id): id is string => !!id)
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
    } else {
      setName('')
      setEntityId('')
      setDescription('')
      setDataSourceId('')
      setBadges([])
      setVersion('0.1.0')
      setAuthoring({})
    }
  }, [editingCatalog, open])

  const handleSubmit = async () => {
    if (!name.trim() || !activeWorkspaceId) return

    if (isEdit && editingCatalog) {
      await updateCatalog(editingCatalog.id, {
        name: setLocalized(editingCatalog.name, language, name.trim()),
        description: setLocalized(editingCatalog.description, language, description.trim()),
        dataSourceId,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('data_catalog.edit_title') : t('data_catalog.create_title')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs">{t('data_catalog.name')}<RequiredMark /></Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('data_catalog.name_placeholder')}
              className="mt-1"
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
          <div>
            <Label className="text-xs">{t('data_catalog.field_description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('data_catalog.field_description_placeholder')}
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">{t('data_catalog.database')}</Label>
            <Select value={dataSourceId} onValueChange={setDataSourceId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={t('data_catalog.select_database')} />
              </SelectTrigger>
              <SelectContent>
                {dbSources.map((ds) => (
                  <SelectItem key={ds.id} value={ds.id}>
                    {ds.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <BadgeEditor value={badges} onChange={setBadges} suggestions={badgeSuggestions} />

          <VersionField value={version} onChange={setVersion} />

          {isEdit && editingCatalog && (
            <div className="border-t pt-4">
              <AuthoringFields
                value={{
                  createdById: 'createdById' in authoring ? authoring.createdById : editingCatalog.createdById,
                  createdBy: authoring.createdBy ?? editingCatalog.createdBy,
                  createdByDetails: authoring.createdByDetails ?? editingCatalog.createdByDetails,
                  organization: authoring.organization ?? editingCatalog.organization,
                }}
                onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || (!isEdit && !isEntityIdValid(entityId, existingIds))}>
            {isEdit ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
