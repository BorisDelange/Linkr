import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useSaveForm } from '@/hooks/use-save-form'
import { useAppStore } from '@/stores/app-store'
import { localized } from '@/lib/localized'
import type { ProjectStatus, BadgeColor, ProjectBadge } from '@/types'
import { Trash2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GatedButton } from '@/components/ui/gated-button'
import { Input } from '@/components/ui/input'
import { BadgeColorButton } from '@/components/ui/badge-color-button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MembersTab } from '@/features/settings/MembersTab'
import { useMyProjectRole } from '@/hooks/use-context-role'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

// Badge/status colour helpers moved to @/lib/badge-colors; re-exported here for
// backward compatibility with existing importers.
export {
  PRESET_COLORS,
  getBadgeClasses,
  getBadgeStyle,
  isCustomColor,
  getStatusClasses,
  getStatusDotClass,
} from '@/lib/badge-colors'
import { getBadgeClasses, getBadgeStyle, getStatusDotClass } from '@/lib/badge-colors'

const STATUS_OPTIONS: ProjectStatus[] = ['active', 'completed', 'archived', 'draft']

export function ProjectSettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid, projectUid: uid } = useResolvedParams()
  const {
    _projectsRaw,
    projects,
    language,
    updateProject,
    updateProjectStatus,
    updateProjectBadges,
    deleteProject,
    closeProject,
  } = useAppStore()

  // Editing needs editor+, deleting needs owner (both enforced server-side too).
  const { can } = useMyProjectRole(uid)
  const canEdit = can('project-settings:write')
  const canDelete = can('project-settings:delete')

  const projectRaw = _projectsRaw.find((p) => p.uid === uid)
  const project = projects.find((p) => p.uid === uid)
  const badges = projectRaw?.badges ?? []
  const status = projectRaw?.status ?? 'active'

  // Badge creation
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')
  const [deleteConfirm, setDeleteConfirm] = useState('')

  const projectDisplayName = project?.name ?? ''

  // Name/description edit the active language only; re-seed when the language
  // (or project) changes so the fields reflect the value for the current lang.
  const [nameInput, setNameInput] = useState('')
  const [descInput, setDescInput] = useState('')
  useEffect(() => {
    setNameInput(localized(projectRaw?.name, language))
    setDescInput(localized(projectRaw?.description, language))
  }, [projectRaw?.name, projectRaw?.description, language])

  const handleSaveGeneral = () => {
    if (!uid) return
    updateProject(uid, nameInput.trim(), descInput.trim())
  }

  const general = useSaveForm({
    current: { name: nameInput, description: descInput },
    baseline: {
      name: localized(projectRaw?.name, language),
      description: localized(projectRaw?.description, language),
    },
    onSave: handleSaveGeneral,
    canSave: !!nameInput.trim(),
  })

  const handleAddBadge = () => {
    if (!uid || !newBadgeLabel.trim()) return
    const badge: ProjectBadge = {
      // eslint-disable-next-line react-hooks/purity -- runs in an event handler, not during render
      id: `b-${Date.now()}`,
      label: newBadgeLabel.trim(),
      color: newBadgeColor,
    }
    updateProjectBadges(uid, [...badges, badge])
    setNewBadgeLabel('')
  }

  const handleRemoveBadge = (id: string) => {
    if (!uid) return
    updateProjectBadges(uid, badges.filter((b) => b.id !== id))
  }

  const handleDelete = async () => {
    if (!uid) return
    await deleteProject(uid)
    closeProject()
    navigate(wsUid ? `/workspaces/${wsUid}/projects` : '/workspaces')
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-2">
        <h1 className="text-2xl font-bold text-foreground">
          {t('project_settings.title')}
        </h1>
      </div>

      <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col px-6">
        <TabsList className="shrink-0 w-fit mx-auto">
          <TabsTrigger value="general">{t('project_settings.general')}</TabsTrigger>
          <TabsTrigger value="members">{t('members.title')}</TabsTrigger>
          <TabsTrigger value="status-badges">{t('project_settings.status_and_badges')}</TabsTrigger>
          {canDelete && <TabsTrigger value="danger" className="text-destructive data-[state=active]:text-destructive">{t('project_settings.danger_zone')}</TabsTrigger>}
        </TabsList>

        {/* General */}
        <TabsContent value="general" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-3xl space-y-6 pt-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('project_settings.general')}</CardTitle>
                <CardDescription>{t('project_settings.general_description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('projects.field_name')}</Label>
                  <Input
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') general.save() }}
                  />
                </div>
                {projectRaw?.projectId && (
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5 text-muted-foreground">
                      {t('entity_id.label')}
                    </Label>
                    <Input value={projectRaw.projectId} disabled className="font-mono text-sm opacity-70" />
                    <p className="text-[11px] text-muted-foreground">{t('entity_id.hint')}</p>
                  </div>
                )}
                <div className="space-y-2">
                  <Label>{t('projects.field_description')}</Label>
                  <Textarea
                    value={descInput}
                    onChange={(e) => setDescInput(e.target.value)}
                    rows={3}
                  />
                </div>
                <GatedButton allowed={canEdit} notAllowedReason={t('common.insufficient_permissions')} size="sm" onClick={general.save} disabled={!general.canSaveNow}>{t('common.save')}</GatedButton>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Members */}
        <TabsContent value="members" className="min-h-0 flex-1 overflow-auto pb-6">
          {uid && <MembersTab scope="project" targetId={uid} />}
        </TabsContent>

        {/* Status & Badges */}
        <TabsContent value="status-badges" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-2xl space-y-6 pt-2">
            {/* Status */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('project_settings.status')}</CardTitle>
                <CardDescription>{t('project_settings.status_description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <Select
                  value={status}
                  disabled={!canEdit}
                  onValueChange={(value) => {
                    if (uid) updateProjectStatus(uid, value as ProjectStatus)
                  }}
                >
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
              </CardContent>
            </Card>

            {/* Badges */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('project_settings.badges')}</CardTitle>
                <CardDescription>{t('project_settings.badges_description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Existing badges */}
                {badges.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {badges.map((badge) => (
                      <span
                        key={badge.id}
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${getBadgeClasses(badge.color)}`}
                        style={getBadgeStyle(badge.color)}
                      >
                        {badge.label}
                        {canEdit && (
                          <button
                            onClick={() => handleRemoveBadge(badge.id)}
                            className="rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/20"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}

                {/* Add badge */}
                <div className="space-y-2">
                  <Label>{t('project_settings.badge_label')}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={newBadgeLabel}
                      onChange={(e) => setNewBadgeLabel(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddBadge()}
                      placeholder={t('project_settings.badge_label_placeholder')}
                      className="h-8 flex-1 text-sm"
                    />
                    <BadgeColorButton value={newBadgeColor} onChange={setNewBadgeColor} />
                    <GatedButton
                      allowed={canEdit}
                      notAllowedReason={t('common.insufficient_permissions')}
                      size="sm"
                      onClick={handleAddBadge}
                      disabled={!newBadgeLabel.trim()}
                      className="gap-1"
                    >
                      <Plus size={14} />
                      {t('project_settings.add_badge')}
                    </GatedButton>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Danger zone — owner only */}
        {canDelete && (
        <TabsContent value="danger" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-2xl pt-2">
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-sm text-destructive">
                  {t('project_settings.danger_zone')}
                </CardTitle>
                <CardDescription>
                  {t('project_settings.danger_zone_description')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm">
                      <Trash2 size={14} />
                      {t('project_settings.delete_project')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('project_settings.delete_confirm_title')}</AlertDialogTitle>
                      <AlertDialogDescription asChild>
                        <div className="space-y-3">
                          <p>{t('project_settings.delete_confirm_description')}</p>
                          <p className="text-sm">
                            {t('project_settings.delete_confirm_type')}{' '}
                            <span className="font-semibold text-foreground">{projectDisplayName}</span>
                          </p>
                          <Input
                            value={deleteConfirm}
                            onChange={(e) => setDeleteConfirm(e.target.value)}
                            placeholder={projectDisplayName}
                            className="mt-2"
                          />
                        </div>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel onClick={() => setDeleteConfirm('')}>
                        {t('common.cancel')}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        disabled={deleteConfirm !== projectDisplayName}
                        className="!bg-destructive !text-white hover:!bg-destructive/90 disabled:!opacity-50"
                        onClick={handleDelete}
                      >
                        {t('project_settings.delete_project')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
