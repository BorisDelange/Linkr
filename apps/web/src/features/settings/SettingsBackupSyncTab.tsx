import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SettingsImportTab } from './SettingsImportTab'
import { SettingsExportTab } from './SettingsExportTab'
import { SettingsVersioningTab } from './SettingsVersioningTab'

/**
 * Backup & sync: everything that moves account-level settings (organizations,
 * users, roles) in or out — grouped under one root tab so it's a single entry in
 * the Settings nav. Import (ZIP or git), Export (ZIP), and git Versioning (push +
 * behind-banner pull).
 */
export function SettingsBackupSyncTab() {
  const { t } = useTranslation()
  return (
    <Tabs defaultValue="import" className="mt-4">
      <TabsList className="mx-auto w-fit">
        <TabsTrigger value="import">{t('settings.tab_import')}</TabsTrigger>
        <TabsTrigger value="export">{t('settings.tab_export')}</TabsTrigger>
        <TabsTrigger value="git">{t('settings.tab_versioning')}</TabsTrigger>
      </TabsList>
      <TabsContent value="import">
        <SettingsImportTab />
      </TabsContent>
      <TabsContent value="export">
        <SettingsExportTab />
      </TabsContent>
      <TabsContent value="git">
        <SettingsVersioningTab />
      </TabsContent>
    </Tabs>
  )
}
