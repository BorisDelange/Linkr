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
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
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

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [defaultDbId, setDefaultDbId] = useState('')
  const [saving, setSaving] = useState(false)

  const isEditing = !!editingCollection

  useEffect(() => {
    if (open && editingCollection) {
      setName(editingCollection.name)
      setDescription(editingCollection.description)
      setDefaultDbId(editingCollection.defaultDataSourceId ?? '')
    } else if (open && !editingCollection) {
      setName('')
      setDescription('')
      setDefaultDbId('')
    }
  }, [open, editingCollection])

  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database' && !ds.isVocabularyReference)

  const handleSubmit = async () => {
    if (!name.trim() || !activeWorkspaceId) return
    setSaving(true)
    try {
      if (isEditing && editingCollection) {
        await updateCollection(editingCollection.id, {
          name: name.trim(),
          description: description.trim(),
          defaultDataSourceId: defaultDbId || undefined,
        })
        onOpenChange(false)
      } else {
        const now = new Date().toISOString()
        const collection: SqlScriptCollection = {
          id: crypto.randomUUID(),
          workspaceId: activeWorkspaceId,
          name: name.trim(),
          description: description.trim(),
          defaultDataSourceId: defaultDbId || undefined,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? t('sql_scripts.edit_title') : t('sql_scripts.create_title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>{t('sql_scripts.collection_name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('sql_scripts.collection_name_placeholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) handleSubmit()
              }}
              autoFocus
            />
          </div>

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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || saving}
          >
            {isEditing ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
