import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/stores/app-store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId?: string
}

export function CreateProjectDialog({ open, onOpenChange, workspaceId }: CreateProjectDialogProps) {
  const { t } = useTranslation()
  const { addProject, _projectsRaw } = useAppStore()
  const [name, setName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [description, setDescription] = useState('')

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setName('')
      setEntityId('')
      setDescription('')
    }
  }, [open])

  const existingIds = _projectsRaw
    .filter(p => p.workspaceId === workspaceId)
    .map(p => p.projectId)
    .filter((id): id is string => !!id)

  const canSubmit = name.trim().length > 0 && isEntityIdValid(entityId, existingIds)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    await addProject(name.trim(), description.trim(), workspaceId, entityId)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('projects.create_dialog_title')}</DialogTitle>
            <DialogDescription>{t('projects.create_dialog_description')}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="project-name">{t('projects.field_name')}</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('projects.field_name_placeholder')}
                autoFocus
              />
            </div>
            <EntityIdField
              name={name}
              value={entityId}
              onChange={setEntityId}
              existingIds={existingIds}
              htmlId="project-id"
              placeholder="my-project"
            />
            <div className="space-y-2">
              <Label htmlFor="project-description">{t('projects.field_description')}</Label>
              <Textarea
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('projects.field_description_placeholder')}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
