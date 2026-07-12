import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useAppStore } from '@/stores/app-store'
import type { ProjectStatus, BadgeColor, ProjectBadge } from '@/types'
import { Trash2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GatedButton } from '@/components/ui/gated-button'
import { Input } from '@/components/ui/input'
import { BadgeColorButton } from '@/components/ui/badge-color-button'
import { Label } from '@/components/ui/label'
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
import { getBadgeClasses, getBadgeStyle, getStatusClasses, getStatusDotClass } from '@/lib/badge-colors'

const STATUS_OPTIONS: ProjectStatus[] = ['active', 'completed', 'archived', 'draft']

export function ProjectSettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid, projectUid: uid } = useResolvedParams()
  const {
    _projectsRaw,
    projects,
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

      <Tabs defaultValue="members" className="flex min-h-0 flex-1 flex-col px-6">
        <TabsList className="shrink-0 w-fit mx-auto">
          <TabsTrigger value="members">{t('members.title')}</TabsTrigger>
          <TabsTrigger value="status-badges">{t('project_settings.status_and_badges')}</TabsTrigger>
          {canDelete && <TabsTrigger value="danger" className="text-destructive data-[state=active]:text-destructive">{t('project_settings.danger_zone')}</TabsTrigger>}
        </TabsList>

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
                <div className="flex flex-wrap gap-2">
                  {STATUS_OPTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={!canEdit}
                      onClick={() => { if (uid) updateProjectStatus(uid, s) }}
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all border disabled:cursor-not-allowed disabled:opacity-60 ${
                        status === s
                          ? 'border-transparent ' + getStatusClasses(s)
                          : 'border-border bg-background text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      <span className={`size-1.5 rounded-full ${status === s ? getStatusDotClass(s) : 'bg-muted-foreground'}`} />
                      {t(`project_settings.status_${s}`)}
                    </button>
                  ))}
                </div>
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
