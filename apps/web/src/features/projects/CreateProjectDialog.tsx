import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/stores/app-store'
import { localized } from '@/lib/localized'
import type { Project, ProjectStatus, ProjectBadge } from '@/types'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { AuthoringFields, type AuthoringValue } from '@/components/ui/authoring-fields'
import { BadgeEditor } from '@/components/ui/badge-editor'
import { EntityDialogTabs } from '@/components/ui/entity-dialog-tabs'
import { useBadgeSuggestions } from '@/hooks/use-badge-suggestions'
import { VersionField } from '@/components/ui/version-field'
import { RequiredMark } from '@/components/ui/required-mark'
import { getStatusDotClass } from './ProjectSettingsPage'

const STATUS_OPTIONS: ProjectStatus[] = ['active', 'completed', 'archived', 'draft']

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId?: string
  editingProject?: Project
}

export function CreateProjectDialog({ open, onOpenChange, workspaceId, editingProject }: CreateProjectDialogProps) {
  const { t } = useTranslation()
  const { addProject, updateProject, updateProjectStatus, updateProjectBadges, updateProjectVersion, updateProjectAuthoring, _projectsRaw, language } = useAppStore()
  const isEditing = !!editingProject
  const [name, setName] = useState('')
  const [entityId, setEntityId] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<ProjectStatus>('active')
  const [badges, setBadges] = useState<ProjectBadge[]>([])
  const [version, setVersion] = useState('0.1.0')
  const [authoring, setAuthoring] = useState<Partial<AuthoringValue>>({})

  // Reset form when dialog opens; seed from the edited project when present.
  useEffect(() => {
    if (open) {
      setName(editingProject ? localized(editingProject.name, language) : '')
      // In edit mode the field is read-only, so show the real identifier rather
      // than an empty box.
      setEntityId(editingProject?.projectId ?? '')
      setDescription(editingProject ? localized(editingProject.description, language) : '')
      setStatus(editingProject?.status ?? 'active')
      setBadges(editingProject?.badges ?? [])
      setVersion(editingProject?.version ?? '0.1.0')
      setAuthoring({})
    }
  }, [open, editingProject, language])

  const badgeSuggestions = useBadgeSuggestions(_projectsRaw, workspaceId, editingProject?.uid)

  const existingIds = _projectsRaw
    .filter(p => p.workspaceId === workspaceId)
    .map(p => p.projectId)
    .filter((id): id is string => !!id)

  const canSubmit = name.trim().length > 0 && (isEditing || isEntityIdValid(entityId, existingIds))

  const handleSubmit = async () => {
    if (!canSubmit) return
    if (isEditing && editingProject) {
      await updateProject(editingProject.uid, name.trim(), description.trim())
      updateProjectStatus(editingProject.uid, status)
      updateProjectBadges(editingProject.uid, badges)
      updateProjectVersion(editingProject.uid, version.trim() || '0.1.0')
      // Authoring re-attribution isn't covered by the name/status/badges stores;
      // this both persists it and refreshes the in-memory project so the widget
      // updates without a page reload.
      if (Object.keys(authoring).length > 0) {
        await updateProjectAuthoring(editingProject.uid, authoring)
      }
    } else {
      const uid = await addProject(name.trim(), description.trim(), workspaceId, entityId)
      if (status !== 'active') updateProjectStatus(uid, status)
      if (badges.length > 0) updateProjectBadges(uid, badges)
      if (version.trim() && version.trim() !== '0.1.0') updateProjectVersion(uid, version.trim())
    }
    onOpenChange(false)
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={isEditing ? t('projects.edit_dialog_title') : t('projects.create_dialog_title')}
      description={isEditing ? t('projects.edit_dialog_description') : t('projects.create_dialog_description')}
      onConfirm={handleSubmit}
      confirmLabel={isEditing ? t('common.save') : t('common.create')}
      confirmDisabled={!canSubmit}
    >
      <EntityDialogTabs
        general={
          <>
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
            <EntityIdField
              name={name}
              value={entityId}
              onChange={setEntityId}
              existingIds={existingIds}
              htmlId="project-id"
              placeholder="my-project"
              required
              readOnly={isEditing}
            />
            <div className="space-y-2">
              <Label htmlFor="project-description">{t('projects.field_description')}</Label>
              <Input
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('projects.field_description_placeholder')}
              />
            </div>
          </>
        }
        metadata={
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
            <BadgeEditor
              value={badges}
              onChange={setBadges}
              suggestions={badgeSuggestions}
              label={t('project_settings.badges')}
            />
            <VersionField value={version} onChange={setVersion} />
          </>
        }
        attribution={
          isEditing && editingProject ? (
            <AuthoringFields
              value={{
                createdById: 'createdById' in authoring ? authoring.createdById : editingProject.createdById,
                createdBy: authoring.createdBy ?? editingProject.createdBy,
                createdByDetails: authoring.createdByDetails ?? editingProject.createdByDetails,
                organization: authoring.organization ?? editingProject.organization,
              }}
              onChange={(patch) => setAuthoring((a) => ({ ...a, ...patch }))}
            />
          ) : undefined
        }
      />
    </DialogShell>
  )
}
