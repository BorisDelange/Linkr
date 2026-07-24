import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useAppStore } from '@/stores/app-store'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MembersTab } from '@/features/settings/MembersTab'
import { FoldersTab } from './FoldersTab'
import { isServerMode } from '@/lib/api-client'
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

export function ProjectSettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid, projectUid: uid } = useResolvedParams()
  const {
    projects,
    deleteProject,
    closeProject,
  } = useAppStore()

  // Deleting needs owner (enforced server-side too).
  const { can } = useMyProjectRole(uid)
  const canDelete = can('project-settings:delete')
  // Folder bindings are a server-mode, project-settings:write concern. Non-writers
  // still see the tab (read-only current paths) so it renders whenever server mode.
  const canEditFolders = can('project-settings:write')
  const showFolders = isServerMode()

  const project = projects.find((p) => p.uid === uid)

  const [deleteConfirm, setDeleteConfirm] = useState('')

  const projectDisplayName = project?.name ?? ''

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
          {showFolders && <TabsTrigger value="folders">{t('project_folders.title')}</TabsTrigger>}
          {canDelete && <TabsTrigger value="danger" className="text-destructive data-[state=active]:text-destructive">{t('project_settings.danger_zone')}</TabsTrigger>}
        </TabsList>

        {/* Members */}
        <TabsContent value="members" className="min-h-0 flex-1 overflow-auto pb-6">
          {uid && <MembersTab scope="project" targetId={uid} />}
        </TabsContent>

        {/* Folders — server mode only */}
        {showFolders && uid && (
          <TabsContent value="folders" className="min-h-0 flex-1 overflow-auto pb-6">
            <FoldersTab projectUid={uid} canEdit={canEditFolders} />
          </TabsContent>
        )}

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
