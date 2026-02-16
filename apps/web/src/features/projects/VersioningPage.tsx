import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useVersioningStore } from '@/stores/versioning-store'
import { LocalHistoryTab } from './versioning/LocalHistoryTab'
import { RemoteGitTab } from './versioning/RemoteGitTab'
import { ExportTab } from './versioning/ExportTab'

export function VersioningPage() {
  const { t } = useTranslation()
  const { uid } = useParams()
  const { initRepo, loadCommits, refreshStatus } = useVersioningStore()

  useEffect(() => {
    if (!uid) return
    initRepo(uid).then(() => {
      loadCommits(uid)
      refreshStatus(uid)
    })
  }, [uid, initRepo, loadCommits, refreshStatus])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-2">
        <h1 className="text-2xl font-bold text-foreground">
          {t('versioning.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('versioning.description')}
        </p>
      </div>

      <Tabs defaultValue="history" className="flex min-h-0 flex-1 flex-col px-6">
        <TabsList className="shrink-0 w-fit mx-auto">
          <TabsTrigger value="history">{t('versioning.tab_history')}</TabsTrigger>
          <TabsTrigger value="remote">{t('versioning.tab_remote')}</TabsTrigger>
          <TabsTrigger value="export">{t('versioning.tab_export')}</TabsTrigger>
        </TabsList>

        <TabsContent value="history" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-3xl space-y-6 pt-2">
            <LocalHistoryTab />
          </div>
        </TabsContent>

        <TabsContent value="remote" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-3xl space-y-6 pt-2">
            <RemoteGitTab />
          </div>
        </TabsContent>

        <TabsContent value="export" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-3xl space-y-6 pt-2">
            <ExportTab />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
