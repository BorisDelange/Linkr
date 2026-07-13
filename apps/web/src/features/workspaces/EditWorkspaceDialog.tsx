import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import { useSaveForm } from '@/hooks/use-save-form'
import type { Workspace, ProjectBadge, BadgeColor } from '@/types'
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
import { AuthoringFields, type AuthoringValue } from '@/components/ui/authoring-fields'
import { RequiredMark } from '@/components/ui/required-mark'

interface EditWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace?: Workspace
}

export function EditWorkspaceDialog({ open, onOpenChange, workspace }: EditWorkspaceDialogProps) {
  const { t } = useTranslation()
  const { updateWorkspace, updateWorkspaceBadges } = useWorkspaceStore()
  const language = useAppStore((s) => s.language)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})

  useEffect(() => {
    if (open && workspace) {
      setName(localized(workspace.name, language))
      setDescription(localized(workspace.description, language))
      setBadges(workspace.badges ?? [])
      setNewBadgeLabel('')
      setNewBadgeColor('blue')
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
      ...authoring,
    })
    await updateWorkspaceBadges(workspace.id, badges)
    onOpenChange(false)
  }

  const { canSaveNow, save } = useSaveForm({
    current: { name, description, badges, authoring },
    baseline: {
      name: localized(workspace?.name, language),
      description: localized(workspace?.description, language),
      badges: workspace?.badges ?? [],
      authoring: {},
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
