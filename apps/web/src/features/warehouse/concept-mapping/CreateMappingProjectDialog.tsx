import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { MappingProject } from '@/types'

interface CreateMappingProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (projectId: string) => void
  editingProject?: MappingProject | null
}

export function CreateMappingProjectDialog({
  open,
  onOpenChange,
  onCreated,
  editingProject,
}: CreateMappingProjectDialogProps) {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useWorkspaceStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { createMappingProject, updateMappingProject } = useConceptMappingStore()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dataSourceId, setDataSourceId] = useState('')

  const isEdit = !!editingProject

  useEffect(() => {
    if (editingProject) {
      setName(editingProject.name)
      setDescription(editingProject.description)
      setDataSourceId(editingProject.dataSourceId)
    } else {
      setName('')
      setDescription('')
      setDataSourceId('')
    }
  }, [editingProject, open])

  const connectedDatabases = dataSources.filter(
    (ds) => ds.sourceType === 'database' && ds.status === 'connected',
  )

  const handleSubmit = async () => {
    if (!name.trim() || !dataSourceId || !activeWorkspaceId) return

    if (isEdit && editingProject) {
      await updateMappingProject(editingProject.id, {
        name: name.trim(),
        description: description.trim(),
        dataSourceId,
      })
      onOpenChange(false)
    } else {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      await createMappingProject({
        id,
        workspaceId: activeWorkspaceId,
        name: name.trim(),
        description: description.trim(),
        dataSourceId,
        conceptSetIds: [],
        createdAt: now,
        updatedAt: now,
      })
      onOpenChange(false)
      onCreated?.(id)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('concept_mapping.edit_project') : t('concept_mapping.new_project')}
          </DialogTitle>
          <DialogDescription>
            {isEdit ? t('concept_mapping.edit_project_description') : t('concept_mapping.new_project_description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="mp-name">{t('common.name')}</Label>
            <Input
              id="mp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('concept_mapping.project_name_placeholder')}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="mp-desc">{t('common.description')}</Label>
            <Textarea
              id="mp-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('concept_mapping.project_desc_placeholder')}
              rows={3}
            />
          </div>

          <div className="grid gap-2">
            <Label>{t('concept_mapping.source_database')}</Label>
            <Select value={dataSourceId} onValueChange={setDataSourceId}>
              <SelectTrigger>
                <SelectValue placeholder={t('concept_mapping.select_database')} />
              </SelectTrigger>
              <SelectContent>
                {connectedDatabases.map((ds) => (
                  <SelectItem key={ds.id} value={ds.id}>
                    {ds.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
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
