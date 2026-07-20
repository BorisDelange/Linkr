import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { NoAccessNotice } from '@/components/ui/no-access-notice'
import { useHasGlobalPermission } from '@/stores/auth-store'
import { GeneralTab } from './GeneralTab'
import { UsersTab } from './UsersTab'
import { RolesTab } from './RolesTab'
import { OrganizationsTab } from './OrganizationsTab'
import { SettingsVersioningTab } from './SettingsVersioningTab'

export function SettingsPage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  // Tabs stay visible for everyone; a missing permission replaces the tab's
  // contents with a "no access" notice (the real gate is server-side).
  const canManageUsers = useHasGlobalPermission('users:read')
  const canManageRoles = useHasGlobalPermission('roles:read')
  const canManageOrgs = useHasGlobalPermission('organizations:write')
  // Settings versioning pushes/imports users + roles + organizations wholesale
  // (creating accounts) — admin-tier, so require all three management rights.
  const canVersionSettings = canManageUsers && canManageRoles && canManageOrgs
  const defaultTab = searchParams.get('tab') ?? 'general'

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-2xl font-bold text-foreground">
          {t('settings.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('settings.description')}
        </p>

        <Tabs defaultValue={defaultTab} className="mt-6">
          <TabsList className="mx-auto w-fit">
            <TabsTrigger value="general">{t('settings.tab_general')}</TabsTrigger>
            <TabsTrigger value="organizations">{t('settings.tab_organizations')}</TabsTrigger>
            <TabsTrigger value="users">{t('settings.tab_users')}</TabsTrigger>
            <TabsTrigger value="roles">{t('settings.tab_roles')}</TabsTrigger>
            <TabsTrigger value="versioning">{t('settings.tab_versioning')}</TabsTrigger>
          </TabsList>
          <TabsContent value="general">
            <GeneralTab />
          </TabsContent>
          <TabsContent value="organizations">
            {canManageOrgs ? <OrganizationsTab /> : <NoAccessNotice />}
          </TabsContent>
          <TabsContent value="users">
            {canManageUsers ? <UsersTab /> : <NoAccessNotice />}
          </TabsContent>
          <TabsContent value="roles">
            {canManageRoles ? <RolesTab /> : <NoAccessNotice />}
          </TabsContent>
          <TabsContent value="versioning">
            {canVersionSettings ? <SettingsVersioningTab /> : <NoAccessNotice />}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
