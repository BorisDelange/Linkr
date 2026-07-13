import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
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
import { useSaveForm } from '@/hooks/use-save-form'
import { RequiredMark } from '@/components/ui/required-mark'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useAppStore, stampAuthored, stampLineage } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import type { SqlScriptCollection, SqlScriptFile } from '@/types'

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
  const { createCollection, updateCollection, createFile } = useSqlScriptsStore()
  const language = useAppStore((s) => s.language)

  const [name, setName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [description, setDescription] = useState('')
  const [defaultDbId, setDefaultDbId] = useState('')
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})
  const [saving, setSaving] = useState(false)

  const isEditing = !!editingCollection
  const { collections } = useSqlScriptsStore()
  const existingIds = collections.map(c => c.entityId).filter((id): id is string => !!id)

  useEffect(() => {
    if (open && editingCollection) {
      setName(localized(editingCollection.name, language))
      setEntityId(editingCollection.entityId ?? '')
      setDescription(localized(editingCollection.description, language))
      setDefaultDbId(editingCollection.defaultDataSourceId ?? '')
      setAuthoring({})
    } else if (open && !editingCollection) {
      setName('')
      setEntityId('')
      setDescription('')
      setDefaultDbId('')
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
          ...stampAuthored(),
          ...stampLineage(),
          createdAt: now,
          updatedAt: now,
        }
        await createCollection(collection)
        // Create default README.md
        const readme: SqlScriptFile = {
          id: crypto.randomUUID(),
          collectionId: collection.id,
          name: 'README.md',
          type: 'file',
          parentId: null,
          content: `# ${name.trim()}\n\n${description.trim() ? description.trim() + '\n' : ''}`,
          order: 0,
          createdAt: now,
        }
        await createFile(readme)
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
  useSaveForm({
    current: { name: name.trim(), entityId, description: description.trim(), defaultDbId },
    baseline: isEditing
      ? {
          name: localized(editingCollection?.name, language),
          entityId: editingCollection?.entityId ?? '',
          description: localized(editingCollection?.description, language),
          defaultDbId: editingCollection?.defaultDataSourceId ?? '',
        }
      : { name: '', entityId: '', description: '', defaultDbId: '' },
    onSave: handleSubmit,
    canSave: canSubmit,
    enabled: open,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? t('sql_scripts.edit_title') : t('sql_scripts.create_title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
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

          {!isEditing && (
            <EntityIdField
              name={name}
              value={entityId}
              onChange={setEntityId}
              existingIds={existingIds}
              htmlId="sql-collection-id"
              placeholder="my-collection"
              required
            />
          )}

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

          {isEditing && editingCollection && (
            <div className="border-t pt-4">
              <AuthoringFields
                value={{
                  createdById: 'createdById' in authoring ? authoring.createdById : editingCollection.createdById,
                  createdBy: authoring.createdBy ?? editingCollection.createdBy,
                  createdByDetails: authoring.createdByDetails ?? editingCollection.createdByDetails,
                  organization: authoring.organization ?? editingCollection.organization,
                }}
                onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || saving || (!isEditing && !isEntityIdValid(entityId, existingIds))}
          >
            {isEditing ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
