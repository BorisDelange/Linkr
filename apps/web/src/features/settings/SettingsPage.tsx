import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GeneralTab } from './GeneralTab'
import { UsersTab } from './UsersTab'
import { OrganizationsTab } from './OrganizationsTab'

export function SettingsPage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const defaultTab = searchParams.get('tab') ?? 'general'

  return (
    <div className="h-full overflow-auto">
      <div className="px-6 py-10">
        <h1 className="text-2xl font-bold text-foreground">
          {t('settings.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('settings.description')}
        </p>

        <Tabs defaultValue={defaultTab} className="mt-6">
          <TabsList>
            <TabsTrigger value="general">{t('settings.tab_general')}</TabsTrigger>
            <TabsTrigger value="organizations">{t('settings.tab_organizations')}</TabsTrigger>
            <TabsTrigger value="users">{t('settings.tab_users')}</TabsTrigger>
          </TabsList>
          <TabsContent value="general">
            <GeneralTab />
          </TabsContent>
          <TabsContent value="organizations">
            <OrganizationsTab />
          </TabsContent>
          <TabsContent value="users">
            <UsersTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
