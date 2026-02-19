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
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { getDefaultDimensions } from '@/types'
import type { DataCatalog } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingCatalog?: DataCatalog | null
  onCreated?: (catalogId: string) => void
}

export function CreateCatalogDialog({ open, onOpenChange, editingCatalog, onCreated }: Props) {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useWorkspaceStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { createCatalog, updateCatalog } = useCatalogStore()
  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database')

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dataSourceId, setDataSourceId] = useState('')

  const isEdit = !!editingCatalog

  useEffect(() => {
    if (editingCatalog) {
      setName(editingCatalog.name)
      setDescription(editingCatalog.description)
      setDataSourceId(editingCatalog.dataSourceId)
    } else {
      setName('')
      setDescription('')
      setDataSourceId('')
    }
  }, [editingCatalog, open])

  const handleSubmit = async () => {
    if (!name.trim() || !dataSourceId || !activeWorkspaceId) return

    if (isEdit && editingCatalog) {
      await updateCatalog(editingCatalog.id, { name: name.trim(), description: description.trim(), dataSourceId })
      onOpenChange(false)
    } else {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      await createCatalog({
        id,
        workspaceId: activeWorkspaceId,
        name: name.trim(),
        description: description.trim(),
        dataSourceId,
        dimensions: getDefaultDimensions(),
        anonymization: { threshold: 10, mode: 'replace' },
        status: 'draft',
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
            <Label className="text-xs">{t('data_catalog.name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('data_catalog.name_placeholder')}
              className="mt-1"
              autoFocus
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
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || !dataSourceId}>
            {isEdit ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
