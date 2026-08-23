import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { AuthoringFields, type AuthoringValue } from '@/components/ui/authoring-fields'
import { BadgeEditor } from '@/components/ui/badge-editor'
import { useBadgeCategories } from '@/hooks/use-badge-categories'
import { EntityDialogTabs } from '@/components/ui/entity-dialog-tabs'
import { VersionField } from '@/components/ui/version-field'
import { useSaveForm } from '@/hooks/use-save-form'
import { useBadgeSuggestions } from '@/hooks/use-badge-suggestions'
import { RequiredMark } from '@/components/ui/required-mark'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useAppStore, stampAuthored, stampLineage } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import type { ProjectBadge, SqlScriptCollection } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (collectionId: string) => void
  editingCollection?: SqlScriptCollection | null
}

export function CreateSqlScriptsDialog({ open, onOpenChange, onCreated, editingCollection }: Props) {
  const { t } = useTranslation()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { activeWorkspaceId } = useWorkspaceStore()
  const { createCollection, updateCollection } = useSqlScriptsStore()
  const language = useAppStore((s) => s.language)

  const [name, setName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [description, setDescription] = useState('')
  const [defaultDbId, setDefaultDbId] = useState('')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [version, setVersion] = useState('0.1.0')
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})
  const [saving, setSaving] = useState(false)

  const isEditing = !!editingCollection
  const { collections } = useSqlScriptsStore()
  const existingIds = collections.map(c => c.entityId).filter((id): id is string => !!id)
  const badgeCategories = useBadgeCategories()
  const badgeSuggestions = useBadgeSuggestions(collections, activeWorkspaceId, editingCollection?.id)

  useEffect(() => {
    if (open && editingCollection) {
      setName(localized(editingCollection.name, language))
      setEntityId(editingCollection.entityId ?? '')
      setDescription(localized(editingCollection.description, language))
      setDefaultDbId(editingCollection.defaultDataSourceId ?? '')
      setBadges(editingCollection.badges ?? [])
      setVersion(editingCollection.version ?? '0.1.0')
      setAuthoring({})
    } else if (open && !editingCollection) {
      setName('')
      setEntityId('')
      setDescription('')
      setDefaultDbId('')
      setBadges([])
      setVersion('0.1.0')
      setAuthoring({})
    }
  }, [open, editingCollection, language])

  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database' && !ds.isVocabularyReference)

  const handleSubmit = async () => {
    if (!name.trim() || !activeWorkspaceId) return
    if (!isEditing && !isEntityIdValid(entityId, existingIds)) return
    setSaving(true)
    try {
      if (isEditing && editingCollection) {
        await updateCollection(editingCollection.id, {
          name: setLocalized(editingCollection.name, language, name.trim()),
          description: setLocalized(editingCollection.description, language, description.trim()),
          defaultDataSourceId: defaultDbId || undefined,
          badges,
          version: version.trim() || '0.1.0',
          ...authoring,
        })
        onOpenChange(false)
      } else {
        const now = new Date().toISOString()
        const collection: SqlScriptCollection = {
          id: crypto.randomUUID(),
          entityId: entityId || undefined,
          workspaceId: activeWorkspaceId,
          name: setLocalized({}, language, name.trim()),
          description: setLocalized({}, language, description.trim()),
          defaultDataSourceId: defaultDbId || undefined,
          badges,
          version: version.trim() || '0.1.0',
          // A README from the start: the collection is git-versionable, and a repo
          // whose first file is a numbered SQL script says nothing about what the
          // collection is for. It lives on the entity, not in the file tree.
          readme: setLocalized({}, language, `# ${name.trim()}\n`),
          ...stampAuthored(),
          ...stampLineage(),
          createdAt: now,
          updatedAt: now,
        }
        await createCollection(collection)
        onOpenChange(false)
        setName('')
        setDescription('')
        setDefaultDbId('')
        onCreated?.(collection.id)
      }
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = !!name.trim() && !saving && (isEditing || isEntityIdValid(entityId, existingIds))
  const { canSaveNow } = useSaveForm({
    // Badges are compared as JSON: the hook diffs by value, and a fresh array each
    // render would otherwise read as dirty on every keystroke.
    current: { name: name.trim(), entityId, description: description.trim(), defaultDbId, version: version.trim(), badges: JSON.stringify(badges) },
    baseline: isEditing
      ? {
          name: localized(editingCollection?.name, language),
          entityId: editingCollection?.entityId ?? '',
          description: localized(editingCollection?.description, language),
          defaultDbId: editingCollection?.defaultDataSourceId ?? '',
          version: editingCollection?.version ?? '0.1.0',
          badges: JSON.stringify(editingCollection?.badges ?? []),
        }
      : { name: '', entityId: '', description: '', defaultDbId: '', version: '', badges: '[]' },
    onSave: handleSubmit,
    canSave: canSubmit,
    enabled: open,
  })

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={isEditing ? t('sql_scripts.edit_title') : t('sql_scripts.create_title')}
      onConfirm={handleSubmit}
      confirmLabel={isEditing ? t('common.save') : t('common.create')}
      confirmDisabled={isEditing ? !canSaveNow : !canSubmit}
      dirtyTracked={isEditing}
      busy={saving}
    >
      <EntityDialogTabs
        general={
          <>
            <div className="space-y-2">
              <Label>{t('sql_scripts.collection_name')}<RequiredMark /></Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('sql_scripts.collection_name_placeholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && name.trim()) { e.preventDefault(); handleSubmit() }
                }}
                autoFocus
              />
            </div>
            <EntityIdField
              name={name}
              value={entityId}
              onChange={setEntityId}
              existingIds={existingIds}
              htmlId="sql-collection-id"
              placeholder="my-collection"
              required
              readOnly={isEditing}
            />
            <div className="space-y-2">
              <Label>{t('common.description')}</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder=""
              />
            </div>
            <div className="space-y-2">
              <Label>{t('sql_scripts.default_database')}</Label>
              <Select value={defaultDbId} onValueChange={setDefaultDbId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('sql_scripts.select_database')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">—</SelectItem>
                  {dbSources.map((ds) => (
                    <SelectItem key={ds.id} value={ds.id}>
                      {ds.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('sql_scripts.default_database_hint')}</p>
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
          isEditing && editingCollection ? (
            <AuthoringFields
              value={{
                createdById: 'createdById' in authoring ? authoring.createdById : editingCollection.createdById,
                createdBy: authoring.createdBy ?? editingCollection.createdBy,
                createdByDetails: authoring.createdByDetails ?? editingCollection.createdByDetails,
                organization: authoring.organization ?? editingCollection.organization,
              }}
              onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
            />
          ) : undefined
        }
      />
    </DialogShell>
  )
}
