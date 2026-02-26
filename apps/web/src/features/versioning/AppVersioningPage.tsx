import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useWorkspaceVersioningStore } from '@/stores/workspace-versioning-store'
import { WsLocalHistoryTab } from './WsLocalHistoryTab'
import { WsRemoteGitTab } from './WsRemoteGitTab'
import { WsExportTab } from './WsExportTab'

export function AppVersioningPage() {
  const { t } = useTranslation()
  const { wsUid } = useParams<{ wsUid: string }>()
  const { ensureRepo, loadCommits } = useWorkspaceVersioningStore()

  useEffect(() => {
    if (wsUid) {
      ensureRepo(wsUid).then(() => {
        loadCommits(wsUid)
      })
    }
  }, [wsUid, ensureRepo, loadCommits])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-2 text-center">
        <h1 className="text-2xl font-bold text-foreground">{t('app_versioning.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('app_versioning.description')}</p>
      </div>

      <Tabs defaultValue="history" className="flex min-h-0 flex-1 flex-col px-6">
        <TabsList className="mx-auto w-fit shrink-0">
          <TabsTrigger value="history">{t('versioning.tab_history')}</TabsTrigger>
          <TabsTrigger value="remote">{t('versioning.tab_remote')}</TabsTrigger>
          <TabsTrigger value="export">{t('versioning.tab_export')}</TabsTrigger>
        </TabsList>

        <TabsContent value="history" className="min-h-0 flex-1 flex flex-col pb-6">
          <div className="mx-auto max-w-3xl w-full flex flex-col min-h-0 flex-1 space-y-3 pt-2">
            <WsLocalHistoryTab />
          </div>
        </TabsContent>

        <TabsContent value="remote" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-3xl space-y-6 pt-2">
            <WsRemoteGitTab />
          </div>
        </TabsContent>

        <TabsContent value="export" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-3xl space-y-6 pt-2">
            <WsExportTab />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
