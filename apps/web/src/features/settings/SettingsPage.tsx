import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SectionLabel } from '@/components/ui/section-label'
import { cn } from '@/lib/utils'
import { NoAccessNotice } from '@/components/ui/no-access-notice'
import { useHasGlobalPermission } from '@/stores/auth-store'
import { GeneralTab } from './GeneralTab'
import { UsersTab } from './UsersTab'
import { RolesTab } from './RolesTab'
import { OrganizationsTab } from './OrganizationsTab'
import { SettingsImportTab } from './SettingsImportTab'
import { SettingsExportTab } from './SettingsExportTab'
import { SettingsVersioningTab } from './SettingsVersioningTab'
import { AccessLogTab } from './AccessLogTab'
import { isServerMode } from '@/lib/api-client'

const TABS = ['general', 'access-log', 'organizations', 'users', 'roles', 'import', 'export', 'versioning']
// Import / Export / Versioning used to sit under one "Backup & sync" tab.
const LEGACY_TABS: Record<string, string> = { 'backup-sync': 'import' }

export function SettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { tab } = useParams()
  const [searchParams] = useSearchParams()
  const serverMode = isServerMode()
  // Tabs stay visible for everyone; a missing permission replaces the tab's
  // contents with a "no access" notice (the real gate is server-side).
  const canManageUsers = useHasGlobalPermission('users:read')
  const canManageRoles = useHasGlobalPermission('roles:read')
  const canManageOrgs = useHasGlobalPermission('organizations:write')
  const canReadAccessLog = useHasGlobalPermission('audit-log:read')
  // Settings versioning pushes/imports users + roles + organizations wholesale
  // (creating accounts) — admin-tier, so require all three management rights.
  const canVersionSettings = canManageUsers && canManageRoles && canManageOrgs
  // The active tab lives in the URL (/settings/users) so reload/back land on the
  // same tab; ?tab= is still read for old links.
  const rawTab = tab ?? searchParams.get('tab') ?? 'general'
  const requestedTab = LEGACY_TABS[rawTab] ?? rawTab
  const serverOnly = ['access-log', 'import', 'export', 'versioning']
  const available = TABS.filter((id) => serverMode || !serverOnly.includes(id))
  const activeTab = available.includes(requestedTab) ? requestedTab : 'general'
  const fullPage = activeTab === 'access-log'

  return (
    <div className="h-full overflow-auto">
      {/* The access log is a large table: it takes the page's full width and
          height, the table scrolling inside rather than the page. */}
      <div className={cn('mx-auto px-6 pt-10', fullPage ? 'flex h-full max-w-none flex-col pb-4' : 'max-w-5xl pb-10')}>
        <h1 className="text-2xl font-bold text-foreground">
          {t('settings.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('settings.description')}
        </p>

        <Tabs
          value={activeTab}
          onValueChange={(v) => navigate(`/settings/${v}`, { replace: true })}
          className={cn('mt-6', fullPage && 'min-h-0 flex-1')}
        >
          {/* Two groups so the app's own database (General) is never confused
              with moving accounts in and out (Import / Export / Versioning). */}
          <div className="flex flex-wrap items-end justify-center gap-x-6 gap-y-3">
            <div className="flex flex-col items-center gap-1">
              <SectionLabel>{t('settings.group_application')}</SectionLabel>
              <TabsList>
                <TabsTrigger value="general">{t('settings.tab_general')}</TabsTrigger>
                {serverMode && <TabsTrigger value="access-log">{t('settings.tab_access_log')}</TabsTrigger>}
              </TabsList>
            </div>
            <div className="flex flex-col items-center gap-1">
              <SectionLabel>{t('settings.group_accounts')}</SectionLabel>
              <TabsList>
                <TabsTrigger value="organizations">{t('settings.tab_organizations')}</TabsTrigger>
                <TabsTrigger value="users">{t('settings.tab_users')}</TabsTrigger>
                <TabsTrigger value="roles">{t('settings.tab_roles')}</TabsTrigger>
                {serverMode && (
                  <>
                    <span aria-hidden className="mx-1 h-4 w-px bg-border" />
                    <TabsTrigger value="import">{t('settings.tab_import')}</TabsTrigger>
                    <TabsTrigger value="export">{t('settings.tab_export')}</TabsTrigger>
                    <TabsTrigger value="versioning">{t('settings.tab_versioning')}</TabsTrigger>
                  </>
                )}
              </TabsList>
            </div>
          </div>
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
          {serverMode && (
            <>
              <TabsContent value="import">
                {canVersionSettings ? <SettingsImportTab /> : <NoAccessNotice />}
              </TabsContent>
              <TabsContent value="export">
                {canVersionSettings ? <SettingsExportTab /> : <NoAccessNotice />}
              </TabsContent>
              <TabsContent value="versioning">
                {canVersionSettings ? <SettingsVersioningTab /> : <NoAccessNotice />}
              </TabsContent>
              <TabsContent value="access-log" className="flex min-h-0 flex-col">
                {canReadAccessLog ? <AccessLogTab /> : <NoAccessNotice />}
              </TabsContent>
            </>
          )}
        </Tabs>
      </div>
    </div>
  )
}
