import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import { useSaveForm } from '@/hooks/use-save-form'
import type { Workspace, ProjectBadge, BadgeColor } from '@/types'
import { Plus, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EditableBadge } from '@/components/ui/editable-badge'
import { BadgeColorButton } from '@/components/ui/badge-color-button'
import { AuthoringFields, type AuthoringValue } from '@/components/ui/authoring-fields'
import { RequiredMark } from '@/components/ui/required-mark'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const NONE = '__none__'

interface EditWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace?: Workspace
}

export function EditWorkspaceDialog({ open, onOpenChange, workspace }: EditWorkspaceDialogProps) {
  const { t } = useTranslation()
  const { updateWorkspace, updateWorkspaceBadges } = useWorkspaceStore()
  const organizations = useOrganizationStore((s) => s._organizationsRaw)
  const language = useAppStore((s) => s.language)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')
  const [selectedOrgId, setSelectedOrgId] = useState<string>(NONE)
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})

  useEffect(() => {
    if (open && workspace) {
      setName(localized(workspace.name, language))
      setDescription(localized(workspace.description, language))
      setBadges(workspace.badges ?? [])
      setNewBadgeLabel('')
      setNewBadgeColor('blue')
      setSelectedOrgId(workspace.organizationId ?? NONE)
      setAuthoring({})
    }
  }, [open, workspace, language])

  const handleAddBadge = () => {
    const label = newBadgeLabel.trim()
    if (!label) return
    // No duplicate labels on the same element (case-insensitive).
    if (badges.some((b) => localized(b.label, language).toLowerCase() === label.toLowerCase())) return
    const badge: ProjectBadge = {
      id: `b-${Date.now()}`,
      label: setLocalized({}, language, label),
      color: newBadgeColor,
    }
    setBadges((prev) => [...prev, badge])
    setNewBadgeLabel('')
  }

  const badgeLabelExists = !!newBadgeLabel.trim() && badges.some((b) => localized(b.label, language).toLowerCase() === newBadgeLabel.trim().toLowerCase())

  const handleRemoveBadge = (id: string) => {
    setBadges((prev) => prev.filter((b) => b.id !== id))
  }

  const handleRenameBadge = (id: string, next: string) => {
    setBadges((prev) => prev.map((b) => (b.id === id ? { ...b, label: setLocalized(b.label, language, next) } : b)))
  }

  const doSave = async () => {
    if (!workspace) return
    await updateWorkspace(workspace.id, {
      name: setLocalized(workspace.name, language, name.trim()),
      description: setLocalized(workspace.description, language, description.trim()),
      organizationId: selectedOrgId === NONE ? undefined : selectedOrgId,
      ...authoring,
    })
    await updateWorkspaceBadges(workspace.id, badges)
    onOpenChange(false)
  }

  const { canSaveNow, save } = useSaveForm({
    current: { name, description, badges, selectedOrgId, authoring },
    baseline: {
      name: localized(workspace?.name, language),
      description: localized(workspace?.description, language),
      badges: workspace?.badges ?? [],
      selectedOrgId: workspace?.organizationId ?? NONE,
      authoring: {},
    },
    onSave: doSave,
    canSave: name.trim().length > 0,
  })

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t('workspaces.edit_dialog_title')}
      description={t('workspaces.edit_dialog_description')}
      onConfirm={save}
      confirmLabel={t('common.save')}
      confirmDisabled={!canSaveNow}
    >
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
            <div className="space-y-2">
              <Label>{t('project_settings.badges')}</Label>
              {badges.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {badges.map((badge) => (
                    <EditableBadge
                      key={badge.id}
                      label={localized(badge.label, language)}
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

            {/* Organization (live link, shared across workspaces) */}
            <div className="space-y-2">
              <Label>{t('workspaces.organization_section')}</Label>
              <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('workspaces.select_organization')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('workspaces.no_organization')}</SelectItem>
                  {organizations.map((org) => (
                    <SelectItem key={org.id} value={org.id}>
                      {localized(org.name, language)}
                      {org.type
                        ? ` (${org.type === 'other' && org.customType ? localized(org.customType, language) : t(`workspaces.org_type_${org.type}`)})`
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

            {workspace && (
              <div className="border-t pt-4">
                <AuthoringFields
                  hideOrganization
                  value={{
                    createdById: 'createdById' in authoring ? authoring.createdById : workspace.createdById,
                    createdBy: authoring.createdBy ?? workspace.createdBy,
                    createdByDetails: authoring.createdByDetails ?? workspace.createdByDetails,
                  }}
                  onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
                />
              </div>
            )}
    </DialogShell>
  )
}
