import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { paths } from '@/lib/paths'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { Trash2, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MembersTab } from '@/features/settings/MembersTab'
import { DefaultEnvironmentsTab } from '@/features/workspaces/DefaultEnvironmentsTab'
import { BadgeCategoriesTab } from '@/features/workspaces/BadgeCategoriesTab'
import { AgentSettingsTab } from '@/features/settings/AgentSettingsTab'
import { AgentBenchTab } from '@/features/settings/AgentBenchTab'
import { isServerMode } from '@/lib/api-client'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
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

export function WorkspaceSettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useResolvedParams()
  const { tab } = useParams()
  const [searchParams] = useSearchParams()
  // Deleting needs owner (enforced server-side too).
  const { can, loaded: roleLoaded } = useMyWorkspaceRole(wsUid)
  const canDelete = can('workspace-settings:delete')
  // Owner-only, and enforced server-side too: pointing the assistant at an
  // endpoint decides where prompts (possibly carrying clinical context) go.
  const canConfigureLlm = can('llm-config:write')
  // The active tab lives in the URL (/settings/members) so reload/back land on
  // the same tab; ?tab= is still read for old links. 'organization' is no longer
  // a tab here (moved to the Edit Workspace dialog); gate the owner-only danger
  // tab and the server-only environments tab.
  const requestedTab = tab ?? searchParams.get('tab') ?? 'members'
  const availableTabs = ['members', 'assistant', ...(isServerMode() ? ['environments'] : []), ...(canDelete ? ['danger'] : [])]
  // Hold the requested tab until the role is known: 'danger' is gated on canDelete,
  // which is false while /my-role loads, so a deep-link to it would otherwise snap
  // to 'members' permanently even for the owner.
  const activeTab = availableTabs.includes(requestedTab)
    ? requestedTab
    : roleLoaded
      ? 'members'
      : requestedTab
  const language = useAppStore((s) => s.language)
  const { _workspacesRaw, deleteWorkspace, closeWorkspace } = useWorkspaceStore()

  const workspace = _workspacesRaw.find((ws) => ws.id === wsUid)

  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteProgress, setDeleteProgress] = useState<{ phaseKey: string } | null>(null)

  if (!workspace || !wsUid) return null

  const handleDelete = async () => {
    setDeleteProgress({ phaseKey: 'workspaces.delete_phase_projects' })
    try {
      await deleteWorkspace(wsUid, (phaseKey) => setDeleteProgress({ phaseKey }))
      closeWorkspace()
      navigate('/workspaces')
    } finally {
      setDeleteProgress(null)
    }
  }

  const wsDisplayName = workspace.name[language] ?? workspace.name['en'] ?? Object.values(workspace.name)[0] ?? ''

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-2">
        <h1 className="text-2xl font-bold text-foreground">
          {t('workspaces.settings_title')}
        </h1>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => navigate(paths.workspaceSettings(wsUid, v), { replace: true })}
        className="flex min-h-0 flex-1 flex-col px-6"
      >
        <TabsList className="shrink-0 w-fit mx-auto">
          <TabsTrigger value="members">{t('members.title')}</TabsTrigger>
          <TabsTrigger value="badges">{t('badge_categories.title')}</TabsTrigger>
          {isServerMode() && <TabsTrigger value="environments">{t('workspace_env.title')}</TabsTrigger>}
          <TabsTrigger value="assistant">{t('settings.tab_agent')}</TabsTrigger>
          {canDelete && <TabsTrigger value="danger" className="text-destructive data-[state=active]:text-destructive">{t('workspace_settings.delete_workspace')}</TabsTrigger>}
        </TabsList>

        {/* Members */}
        <TabsContent value="members" className="min-h-0 flex-1 overflow-auto pb-6">
          <MembersTab scope="workspace" targetId={wsUid} />
        </TabsContent>

        {/* Badge categories — the workspace's shared badge vocabulary */}
        <TabsContent value="badges" className="min-h-0 flex-1 overflow-auto pb-6">
          {workspace && (
            <BadgeCategoriesTab workspace={workspace} canWrite={can('workspace-settings:write')} />
          )}
        </TabsContent>

        {/* Default environments (server mode) */}
        {isServerMode() && (
          <TabsContent value="environments" className="min-h-0 flex-1 overflow-auto pb-6">
            <DefaultEnvironmentsTab workspace={workspace} />
          </TabsContent>
        )}

        {/* AI assistant — the LLM endpoint every assistant surface uses */}
        <TabsContent value="assistant" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-3xl">
            <Tabs defaultValue="config" className="mt-2">
              <TabsList className="mx-auto w-fit">
                <TabsTrigger value="config" className="text-xs">
                  {t('agent.subtab_config')}
                </TabsTrigger>
                <TabsTrigger value="tests" className="text-xs">
                  {t('agent.subtab_tests')}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="config">
                <AgentSettingsTab workspaceId={wsUid} canWrite={canConfigureLlm} />
              </TabsContent>
              <TabsContent value="tests">
                <AgentBenchTab workspaceId={wsUid} canWrite={canConfigureLlm} />
              </TabsContent>
            </Tabs>
          </div>
        </TabsContent>

        {/* Danger zone — owner only */}
        {canDelete && (
        <TabsContent value="danger" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-2xl pt-2">
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-sm text-destructive">
                  {t('workspaces.delete_workspace')}
                </CardTitle>
                <CardDescription>
                  {t('workspaces.delete_workspace_description')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm">
                      <Trash2 size={14} />
                      {t('workspaces.delete_workspace')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('workspaces.delete_workspace')}</AlertDialogTitle>
                      <AlertDialogDescription asChild>
                        <div className="space-y-3">
                          <p>{t('workspaces.delete_workspace_description')}</p>
                          <p>
                            {t('workspaces.delete_workspace_confirm')}{' '}
                            <span className="font-semibold text-foreground">{wsDisplayName}</span>
                          </p>
                          <Input
                            value={deleteConfirm}
                            onChange={(e) => setDeleteConfirm(e.target.value)}
                            placeholder={wsDisplayName}
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
                        onClick={handleDelete}
                        disabled={deleteConfirm !== wsDisplayName}
                        className="!bg-destructive !text-white hover:!bg-destructive/90 disabled:!opacity-50"
                      >
                        {t('workspaces.delete_workspace')}
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

      {/* Delete progress modal — non-dismissable while deleteWorkspace runs. */}
      <Dialog open={!!deleteProgress} onOpenChange={() => { /* not dismissable */ }}>
        <DialogContent
          className="max-w-md"
          showCloseButton={false}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-primary" />
              {t('workspaces.delete_progress_title')}
            </DialogTitle>
          </DialogHeader>
          {deleteProgress && (
            <div className="pt-2">
              <p className="text-xs text-muted-foreground">{t(deleteProgress.phaseKey)}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
