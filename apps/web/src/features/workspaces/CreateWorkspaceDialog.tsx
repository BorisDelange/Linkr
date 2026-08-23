import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import type { ProjectBadge, BadgeColor } from '@/types'
import { Plus, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EditableBadge } from '@/components/ui/editable-badge'
import { BadgeColorButton } from '@/components/ui/badge-color-button'
import { RequiredMark } from '@/components/ui/required-mark'
import { localized, setLocalized } from '@/lib/localized'
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
  /** Fired with the new workspace's id, so the caller can open it. Opening also
   *  has to set the active workspace, which is the caller's business. */
  onCreated?: (id: string, name: string) => void
}

const NONE = '__none__'

export function CreateWorkspaceDialog({ open, onOpenChange, onCreated }: CreateWorkspaceDialogProps) {
  const { t, i18n } = useTranslation()
  const { addWorkspace, updateWorkspaceBadges } = useWorkspaceStore()
  const { _organizationsRaw } = useOrganizationStore()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedOrgId, setSelectedOrgId] = useState<string>(NONE)
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')

  const handleAddBadge = () => {
    const label = newBadgeLabel.trim()
    if (!label) return
    // No duplicate labels on the same element (case-insensitive).
    if (badges.some((b) => localized(b.label, i18n.language).toLowerCase() === label.toLowerCase())) return
    const badge: ProjectBadge = {
      id: `b-${Date.now()}`,
      label: setLocalized({}, i18n.language, label),
      color: newBadgeColor,
    }
    setBadges((prev) => [...prev, badge])
    setNewBadgeLabel('')
  }

  const badgeLabelExists = !!newBadgeLabel.trim() && badges.some((b) => localized(b.label, i18n.language).toLowerCase() === newBadgeLabel.trim().toLowerCase())

  const handleRemoveBadge = (id: string) => {
    setBadges((prev) => prev.filter((b) => b.id !== id))
  }

  const handleRenameBadge = (id: string, next: string) => {
    setBadges((prev) => prev.map((b) => (b.id === id ? { ...b, label: setLocalized(b.label, i18n.language, next) } : b)))
  }

  const handleSubmit = async () => {
    if (!name.trim()) return

    const newId = await addWorkspace({
      name: name.trim(),
      description: description.trim(),
      organizationId: selectedOrgId !== NONE ? selectedOrgId : undefined,
    })
    if (badges.length > 0) await updateWorkspaceBadges(newId, badges)
    setName('')
    setDescription('')
    setSelectedOrgId(NONE)
    setBadges([])
    setNewBadgeLabel('')
    setNewBadgeColor('blue')
    onOpenChange(false)
    onCreated?.(newId, name.trim())
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={t('workspaces.create_dialog_title')}
      description={t('workspaces.create_dialog_description')}
      onConfirm={handleSubmit}
      confirmLabel={t('common.create')}
      confirmDisabled={!name.trim()}
    >
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
                      label={localized(badge.label, i18n.language)}
                      color={badge.color}
                      onRemove={() => handleRemoveBadge(badge.id)}
                      onRename={(next) => handleRenameBadge(badge.id, next)}
                    />
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <Input
                  value={newBadgeLabel}
                  onChange={(e) => setNewBadgeLabel(e.target.value)}
                  // Enter adds the badge here; the shell must not also submit.
                  data-no-enter-submit
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
                        {org.type
                          ? ` (${org.type === 'other' && org.customType ? localized(org.customType, i18n.language) : t(`workspaces.org_type_${org.type}`)})`
                          : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-2.5 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
                  <Info size={14} className="mt-0.5 shrink-0" />
                  <p>
                    {t('workspaces.org_create_hint')}{' '}
                    <Link
                      to="/settings/organizations"
                      className="font-medium underline underline-offset-2"
                      onClick={() => onOpenChange(false)}
                    >
                      {t('workspaces.org_create_hint_link')}
                    </Link>
                  </p>
                </div>
              </div>
            </div>
    </DialogShell>
  )
}
