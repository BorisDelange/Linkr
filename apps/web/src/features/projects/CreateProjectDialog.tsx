import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/stores/app-store'
import { localized } from '@/lib/localized'
import type { Project, ProjectStatus, ProjectBadge, BadgeColor } from '@/types'
import { Plus, X } from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { getBadgeClasses, getBadgeStyle, getStatusDotClass, PRESET_COLORS, isCustomColor } from './ProjectSettingsPage'

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
    if (!newBadgeLabel.trim()) return
    const badge: ProjectBadge = {
      id: `b-${Date.now()}`,
      label: newBadgeLabel.trim(),
      color: newBadgeColor,
    }
    setBadges((prev) => [...prev, badge])
    setNewBadgeLabel('')
  }

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
      await addProject(name.trim(), description.trim(), workspaceId, entityId)
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
              <Label htmlFor="project-name">{t('projects.field_name')}</Label>
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
              />
            )}
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
            {isEditing && (
              <>
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
                        <span
                          key={badge.id}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${getBadgeClasses(badge.color)}`}
                          style={getBadgeStyle(badge.color)}
                        >
                          {badge.label}
                          <button
                            type="button"
                            onClick={() => handleRemoveBadge(badge.id)}
                            className="rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/20"
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={newBadgeLabel}
                      onChange={(e) => setNewBadgeLabel(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddBadge() } }}
                      placeholder={t('project_settings.badge_label_placeholder')}
                      className="h-8 w-40 text-sm"
                    />
                    <div className="flex items-center gap-1.5">
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c.value}
                          type="button"
                          onClick={() => setNewBadgeColor(c.value)}
                          className={`h-6 w-6 rounded-full ${c.swatch} ring-offset-background transition-all ${
                            newBadgeColor === c.value
                              ? 'ring-2 ring-ring ring-offset-2'
                              : 'hover:ring-1 hover:ring-ring hover:ring-offset-1'
                          }`}
                        />
                      ))}
                      <div className="relative">
                        <input
                          type="color"
                          value={isCustomColor(newBadgeColor) ? newBadgeColor : '#6366f1'}
                          onChange={(e) => setNewBadgeColor(e.target.value)}
                          className="absolute inset-0 h-6 w-6 cursor-pointer opacity-0"
                        />
                        <div
                          className={`flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/40 text-muted-foreground/60 ring-offset-background transition-all ${
                            isCustomColor(newBadgeColor)
                              ? 'ring-2 ring-ring ring-offset-2'
                              : 'hover:border-muted-foreground/60'
                          }`}
                          style={isCustomColor(newBadgeColor) ? { backgroundColor: newBadgeColor, borderStyle: 'solid', borderColor: newBadgeColor } : undefined}
                        >
                          {!isCustomColor(newBadgeColor) && <Plus size={10} />}
                        </div>
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleAddBadge}
                      disabled={!newBadgeLabel.trim()}
                      className="gap-1"
                    >
                      <Plus size={14} />
                      {t('project_settings.add_badge')}
                    </Button>
                  </div>
                </div>
              </>
            )}
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
