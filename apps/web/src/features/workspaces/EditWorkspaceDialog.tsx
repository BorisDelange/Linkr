import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import { useSaveForm } from '@/hooks/use-save-form'
import type { Workspace } from '@/types'
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
import { RequiredMark } from '@/components/ui/required-mark'

interface EditWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace?: Workspace
}

export function EditWorkspaceDialog({ open, onOpenChange, workspace }: EditWorkspaceDialogProps) {
  const { t } = useTranslation()
  const { updateWorkspace } = useWorkspaceStore()
  const language = useAppStore((s) => s.language)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    if (open && workspace) {
      setName(localized(workspace.name, language))
      setDescription(localized(workspace.description, language))
    }
  }, [open, workspace, language])

  const doSave = async () => {
    if (!workspace) return
    await updateWorkspace(workspace.id, {
      name: setLocalized(workspace.name, language, name.trim()),
      description: setLocalized(workspace.description, language, description.trim()),
    })
    onOpenChange(false)
  }

  const { canSaveNow, save } = useSaveForm({
    current: { name, description },
    baseline: {
      name: localized(workspace?.name, language),
      description: localized(workspace?.description, language),
    },
    onSave: doSave,
    canSave: name.trim().length > 0,
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    save()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('workspaces.edit_dialog_title')}</DialogTitle>
            <DialogDescription>{t('workspaces.edit_dialog_description')}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-ws-name">{t('workspaces.field_name')}<RequiredMark /></Label>
              <Input
                id="edit-ws-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-ws-desc">{t('workspaces.field_description')}</Label>
              <Input
                id="edit-ws-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSaveNow}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
