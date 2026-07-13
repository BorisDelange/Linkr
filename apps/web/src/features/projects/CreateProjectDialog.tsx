import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/stores/app-store'
import { localized } from '@/lib/localized'
import type { Project, ProjectStatus, ProjectBadge, BadgeColor } from '@/types'
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
import { EditableBadge } from '@/components/ui/editable-badge'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { RequiredMark } from '@/components/ui/required-mark'
import { getStatusDotClass } from './ProjectSettingsPage'
import { BadgeColorButton } from '@/components/ui/badge-color-button'

const STATUS_OPTIONS: ProjectStatus[] = ['active', 'completed', 'archived', 'draft']

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId?: string
  editingProject?: Project
}

export function CreateProjectDialog({ open, onOpenChange, workspaceId, editingProject }: CreateProjectDialogProps) {
  const { t } = useTranslation()
  const { addProject, updateProject, updateProjectStatus, updateProjectBadges, _projectsRaw, language } = useAppStore()
  const isEditing = !!editingProject
  const [name, setName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<ProjectStatus>('active')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')

  // Reset form when dialog opens; seed from the edited project when present.
  useEffect(() => {
    if (open) {
      setName(editingProject ? localized(editingProject.name, language) : '')
      setEntityId('')
      setDescription(editingProject ? localized(editingProject.description, language) : '')
      setStatus(editingProject?.status ?? 'active')
      setBadges(editingProject?.badges ?? [])
      setNewBadgeLabel('')
      setNewBadgeColor('blue')
    }
  }, [open, editingProject, language])

  const existingIds = _projectsRaw
    .filter(p => p.workspaceId === workspaceId)
    .map(p => p.projectId)
    .filter((id): id is string => !!id)

  const canSubmit = name.trim().length > 0 && (isEditing || isEntityIdValid(entityId, existingIds))

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
    if (!canSubmit) return
    if (isEditing && editingProject) {
      await updateProject(editingProject.uid, name.trim(), description.trim())
      updateProjectStatus(editingProject.uid, status)
      updateProjectBadges(editingProject.uid, badges)
    } else {
      const uid = await addProject(name.trim(), description.trim(), workspaceId, entityId)
      if (status !== 'active') updateProjectStatus(uid, status)
      if (badges.length > 0) updateProjectBadges(uid, badges)
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEditing ? t('projects.edit_dialog_title') : t('projects.create_dialog_title')}</DialogTitle>
            <DialogDescription>{isEditing ? t('projects.edit_dialog_description') : t('projects.create_dialog_description')}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="project-name">{t('projects.field_name')}<RequiredMark /></Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('projects.field_name_placeholder')}
                autoFocus
              />
            </div>
            {!isEditing && (
              <EntityIdField
                name={name}
                value={entityId}
                onChange={setEntityId}
                existingIds={existingIds}
                htmlId="project-id"
                placeholder="my-project"
                required
              />
            )}
            <div className="space-y-2">
              <Label htmlFor="project-description">{t('projects.field_description')}</Label>
              <Input
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('projects.field_description_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('project_settings.status')}</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as ProjectStatus)}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      <span className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${getStatusDotClass(s)}`} />
                        {t(`project_settings.status_${s}`)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
          </div>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isEditing ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
