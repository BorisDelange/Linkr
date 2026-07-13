import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import type { ProjectBadge, BadgeColor } from '@/types'
import { Plus } from 'lucide-react'
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
import { EditableBadge } from '@/components/ui/editable-badge'
import { BadgeColorButton } from '@/components/ui/badge-color-button'
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
  const { addWorkspace, updateWorkspaceBadges } = useWorkspaceStore()
  const { _organizationsRaw, addOrganization } = useOrganizationStore()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedOrgId, setSelectedOrgId] = useState<string>(NONE)
  const [newOrgName, setNewOrgName] = useState('')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')

  const isCreatingNew = selectedOrgId === CREATE_NEW

  const handleAddBadge = () => {
    const label = newBadgeLabel.trim()
    if (!label) return
    // No duplicate labels on the same element (case-insensitive).
    if (badges.some((b) => b.label.toLowerCase() === label.toLowerCase())) return
    const badge: ProjectBadge = {
      id: `b-${Date.now()}`,
      label,
      color: newBadgeColor,
    }
    setBadges((prev) => [...prev, badge])
    setNewBadgeLabel('')
  }

  const badgeLabelExists = !!newBadgeLabel.trim() && badges.some((b) => b.label.toLowerCase() === newBadgeLabel.trim().toLowerCase())

  const handleRemoveBadge = (id: string) => {
    setBadges((prev) => prev.filter((b) => b.id !== id))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    let orgId: string | undefined
    if (isCreatingNew && newOrgName.trim()) {
      orgId = await addOrganization({ name: newOrgName.trim() })
    } else if (selectedOrgId !== NONE) {
      orgId = selectedOrgId
    }

    const newId = await addWorkspace({
      name: name.trim(),
      description: description.trim(),
      organizationId: orgId,
    })
    if (badges.length > 0) await updateWorkspaceBadges(newId, badges)
    setName('')
    setDescription('')
    setSelectedOrgId(NONE)
    setNewOrgName('')
    setBadges([])
    setNewBadgeLabel('')
    setNewBadgeColor('blue')
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

            {/* Badges */}
            <div className="space-y-2">
              <Label>{t('project_settings.badges')}</Label>
              {badges.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {badges.map((badge) => (
                    <EditableBadge
                      key={badge.id}
                      label={badge.label}
                      color={badge.color}
                      onRemove={() => handleRemoveBadge(badge.id)}
                    />
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <Input
                  value={newBadgeLabel}
                  onChange={(e) => setNewBadgeLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddBadge() } }}
                  placeholder={t('project_settings.badge_label_placeholder')}
                  className="h-8 flex-1 text-sm"
                />
                <BadgeColorButton value={newBadgeColor} onChange={setNewBadgeColor} />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleAddBadge}
                  disabled={!newBadgeLabel.trim() || badgeLabelExists}
                  className="gap-1"
                >
                  <Plus size={14} />
                  {t('project_settings.add_badge')}
                </Button>
              </div>
              {badgeLabelExists && (
                <p className="text-xs text-destructive">{t('project_settings.badge_label_exists')}</p>
              )}
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
