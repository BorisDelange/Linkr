import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { WsLocalHistoryTab } from '@/features/versioning/WsLocalHistoryTab'
import { WsRemoteGitTab } from '@/features/versioning/WsRemoteGitTab'
import { ExportTab } from './versioning/ExportTab'

export function VersioningPage() {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-2 text-center">
        <h1 className="text-2xl font-bold text-foreground">
          {t('versioning.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('versioning.description')}
        </p>
      </div>

      <Tabs defaultValue="export" className="flex min-h-0 flex-1 flex-col px-6">
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
            <ExportTab />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
