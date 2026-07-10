import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useHasGlobalPermission } from '@/stores/auth-store'
import { GeneralTab } from './GeneralTab'
import { UsersTab } from './UsersTab'
import { RolesTab } from './RolesTab'
import { OrganizationsTab } from './OrganizationsTab'

export function SettingsPage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const canManageUsers = useHasGlobalPermission('users:read')
  const canManageRoles = useHasGlobalPermission('roles:read')
  const requestedTab = searchParams.get('tab') ?? 'general'
  // Don't land on a tab the user can't see (e.g. a stale ?tab=users link).
  const defaultTab =
    (requestedTab === 'users' && !canManageUsers) ||
    (requestedTab === 'roles' && !canManageRoles)
      ? 'general'
      : requestedTab

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
            {canManageUsers && <TabsTrigger value="users">{t('settings.tab_users')}</TabsTrigger>}
            {canManageRoles && <TabsTrigger value="roles">{t('settings.tab_roles')}</TabsTrigger>}
          </TabsList>
          <TabsContent value="general">
            <GeneralTab />
          </TabsContent>
          <TabsContent value="organizations">
            <OrganizationsTab />
          </TabsContent>
          {canManageUsers && (
            <TabsContent value="users">
              <UsersTab />
            </TabsContent>
          )}
          {canManageRoles && (
            <TabsContent value="roles">
              <RolesTab />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  )
}
