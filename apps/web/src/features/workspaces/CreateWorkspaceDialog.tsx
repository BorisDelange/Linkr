import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
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
import { localized } from '@/lib/localized'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface CreateWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const NONE = '__none__'
const CREATE_NEW = '__create_new__'

export function CreateWorkspaceDialog({ open, onOpenChange }: CreateWorkspaceDialogProps) {
  const { t, i18n } = useTranslation()
  const { addWorkspace } = useWorkspaceStore()
  const { _organizationsRaw, addOrganization } = useOrganizationStore()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedOrgId, setSelectedOrgId] = useState<string>(NONE)
  const [newOrgName, setNewOrgName] = useState('')

  const isCreatingNew = selectedOrgId === CREATE_NEW

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    let orgId: string | undefined
    if (isCreatingNew && newOrgName.trim()) {
      orgId = await addOrganization({ name: newOrgName.trim() })
    } else if (selectedOrgId !== NONE) {
      orgId = selectedOrgId
    }

    await addWorkspace({
      name: name.trim(),
      description: description.trim(),
      organizationId: orgId,
    })
    setName('')
    setDescription('')
    setSelectedOrgId(NONE)
    setNewOrgName('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('workspaces.create_dialog_title')}</DialogTitle>
            <DialogDescription>{t('workspaces.create_dialog_description')}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            {/* Workspace fields */}
            <div className="space-y-2">
              <Label htmlFor="ws-name">{t('workspaces.field_name')}<RequiredMark /></Label>
              <Input
                id="ws-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('workspaces.field_name_placeholder')}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ws-desc">{t('workspaces.field_description')}</Label>
              <Input
                id="ws-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('workspaces.field_description_placeholder')}
              />
            </div>

            {/* Organization picker */}
            <div className="border-t pt-4">
              <Label className="text-sm font-medium">{t('workspaces.organization_section')}</Label>
              <div className="mt-2 space-y-2">
                <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('workspaces.select_organization')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('workspaces.no_organization')}</SelectItem>
                    {_organizationsRaw.map((org) => (
                      <SelectItem key={org.id} value={org.id}>
                        {localized(org.name, i18n.language)}
                        {org.type ? ` (${t(`workspaces.org_type_${org.type}`)})` : ''}
                      </SelectItem>
                    ))}
                    <SelectItem value={CREATE_NEW}>{t('workspaces.create_new_organization')}</SelectItem>
                  </SelectContent>
                </Select>

                {isCreatingNew && (
                  <Input
                    value={newOrgName}
                    onChange={(e) => setNewOrgName(e.target.value)}
                    placeholder={t('workspaces.field_org_name_placeholder')}
                  />
                )}
              </div>
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
