import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { BarChart3, ClipboardCheck, Code, Database, FileText, Info, Pencil, Search, ShieldCheck } from 'lucide-react'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useUrlTab } from '@/hooks/use-url-tab'
import { resolveByIdPrefix } from '@/lib/short-id'
import { paths } from '@/lib/paths'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EntitySecondaryTabsTrigger } from '@/components/ui/entity-secondary-tabs'
import { GitRepositoryTab } from '@/components/versioning/GitRepositoryTab'
import { makeReinstall } from '@/lib/entity-reinstall'
import { Badge } from '@/components/ui/badge'
import { BadgeStrip } from '@/components/ui/badge-strip'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { EntityLicensePanel, EntityReadmePanel } from '@/components/ui/entity-docs-panels'
import { ReadmeMarkdown } from '@/components/editor/MarkdownRenderer'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { isForeignDatabase } from '@/hooks/use-database-options'
import { profileRuleSet, profileRunChecks } from '@/lib/dq-profile'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import { EntityNotFound } from '@/components/layout/EntityNotFound'
import { DatabaseSqlTab } from '@/features/projects/warehouse/databases/DatabaseSqlTab'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useDqStore } from '@/stores/dq-store'
import { useDqProfileStore } from '@/stores/dq-profile-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { runOutcome, type DqReport } from '@/lib/duckdb/data-quality'
import type { DqProfile } from '@/types'
import { CreateDqProfileDialog } from './CreateDqProfileDialog'
import { DqProfileChecksTab } from './DqProfileChecksTab'
import { useDqProfileActions } from './use-dq-profile-actions'
import { DqResultsView } from './DqResultsView'

const TAB_IDS = ['overview', 'checks', 'results', 'investigate', 'readme', 'license', 'versioning'] as const
type TabId = (typeof TAB_IDS)[number]

const TABS: { id: TabId; labelKey: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'overview', labelKey: 'databases.detail_overview', icon: Info },
  { id: 'checks', labelKey: 'data_quality.tab_checks', icon: Code },
  { id: 'results', labelKey: 'data_quality.tab_results', icon: BarChart3 },
  { id: 'investigate', labelKey: 'data_quality.tab_investigate', icon: Search },
]

/**
 * A quality profile: the checks it takes from the workspace's rule sets
 * (Checks), their run on its database (Results), and the console a failing
 * check opens (Investigate).
 */
export function DqProfileDetailPage({ profileId }: { profileId: string }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { wsUid, raw } = useResolvedParams()
  const {
    profiles, profilesLoaded, loadProfiles, updateProfile, checksByRuleSet, loadRuleSetChecks,
    runHistory, loadRunHistory, addRunHistory, deleteRunHistory, clearRunHistory,
  } = useDqProfileStore()
  const { dqRuleSets, dqRuleSetsLoaded, loadDqRuleSets } = useDqStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const canWrite = useMyWorkspaceRole().can('data-quality:write')

  const [activeTab, setActiveTab] = useUrlTab<TabId>({ key: `dq-profile:${profileId}`, tabs: TAB_IDS, defaultTab: 'overview' })
  const [readmeEditing, setReadmeEditing] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [investigation, setInvestigation] = useState<{ sql: string; n: number } | null>(null)
  const handleInvestigate = useCallback((sql: string) => {
    setInvestigation((prev) => ({ sql: sql.trim(), n: (prev?.n ?? 0) + 1 }))
    setActiveTab('investigate')
  }, [setActiveTab])
  // The overview's Edit opens the Readme in edit mode; leaving the tab resets it
  // (cleared on the render after leaving, not during it — see DqRuleSetDetailPage).
  const wasOnReadme = useRef(false)
  useEffect(() => {
    if (activeTab === 'readme') wasOnReadme.current = true
    else if (wasOnReadme.current) {
      wasOnReadme.current = false
      setReadmeEditing(false)
    }
  }, [activeTab])
  const profileActions = useDqProfileActions()
  const canReinstall = useMyWorkspaceRole().atLeast('owner')

  useEffect(() => {
    if (!profilesLoaded) void loadProfiles()
  }, [profilesLoaded, loadProfiles])
  useEffect(() => {
    if (!dqRuleSetsLoaded) void loadDqRuleSets()
  }, [dqRuleSetsLoaded, loadDqRuleSets])

  // profileId may be a short prefix from the URL.
  const profile = resolveByIdPrefix(profiles, profileId, (p) => p.id)
  const fullId = profile?.id

  // The workspace's rule sets, the ones the profile draws from first.
  const ruleSets = useMemo(() => {
    if (!profile) return []
    const order = new Map(profile.sources.map((s, i) => [s.ruleSetId, i]))
    return dqRuleSets
      .filter((rs) => rs.workspaceId === profile.workspaceId)
      .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity)
        || localized(a.name, i18n.language).localeCompare(localized(b.name, i18n.language)))
      .map(profileRuleSet)
  }, [profile, dqRuleSets, i18n.language])
  const ruleSetIds = useMemo(() => ruleSets.map((r) => r.ruleSet.id).join(','), [ruleSets])

  useEffect(() => {
    if (ruleSetIds) void loadRuleSetChecks(ruleSetIds.split(','))
  }, [ruleSetIds, loadRuleSetChecks])
  useEffect(() => {
    if (fullId) void loadRunHistory(fullId)
  }, [fullId, loadRunHistory])

  const runChecks = useMemo(
    () => (profile ? profileRunChecks(profile.sources, ruleSets.map((r) => r.ruleSet), checksByRuleSet, (rs) => localized(rs.name, i18n.language)) : []),
    [profile, ruleSets, checksByRuleSet, i18n.language],
  )
  const history = useMemo(() => fullId ? {
    entries: runHistory.filter((e) => e.profileId === fullId),
    onDelete: (id: string) => void deleteRunHistory(id),
    onClear: () => void clearRunHistory(fullId),
  } : undefined, [fullId, runHistory, deleteRunHistory, clearRunHistory])

  const handleScanComplete = useCallback((report: DqReport) => {
    if (!profile) return
    const { score, durationMs } = runOutcome(report)
    void updateProfile(profile.id, {
      status: 'success',
      lastRunAt: report.computedAt,
      lastRunDurationMs: durationMs,
      lastScore: score,
    }).catch((e) => console.warn('[dq] profile persist:', e))
    void addRunHistory({
      id: crypto.randomUUID(),
      profileId: profile.id,
      dataSourceId: profile.dataSourceId,
      startedAt: report.computedAt,
      completedAt: new Date().toISOString(),
      status: 'success',
      score,
      totalChecks: report.summary.total,
      passed: report.summary.passed,
      failed: report.summary.failed,
      errors: report.summary.errors,
      notApplicable: report.summary.notApplicable,
      durationMs,
      report,
    }).catch((e) => console.warn('[dq] run-history persist:', e))
  }, [profile, updateProfile, addRunHistory])

  // The server recorded the run: its history row and the profile's last score.
  const handleServerRunDone = useCallback(() => {
    if (!fullId) return
    void loadRunHistory(fullId)
    void loadProfiles()
  }, [fullId, loadRunHistory, loadProfiles])

  if (!profilesLoaded) return null
  if (!profile) {
    return (
      <EntityNotFound
        entityLabel={t('common.entity_dq_profile')}
        entityId={raw.profileId}
        onBack={() => wsUid && navigate(paths.warehouseDqProfiles(wsUid))}
        backLabel={t('common.back_to_dq_profiles')}
      />
    )
  }

  const runnableSourceId = isForeignDatabase(dataSources, profile.dataSourceId, profile.workspaceId) ? '' : profile.dataSourceId
  const databaseName = localized(dataSources.find((ds) => ds.id === profile.dataSourceId)?.name, i18n.language)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabId)} className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center px-6 py-3">
          <div className="min-w-0 flex-1" />
          <TabsList>
            {TABS.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                <tab.icon size={14} />
                {t(tab.labelKey)}
              </TabsTrigger>
            ))}
            <EntitySecondaryTabsTrigger
              activeTab={activeTab}
              onSelect={setActiveTab}
              onExport={() => void profileActions.onExport(profile)}
            />
          </TabsList>
          {/* The database the profile runs on: it was chosen at creation and is
              changed from the profile's Edit dialog. */}
          <div className="flex min-w-0 flex-1 justify-end">
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Database size={12} className="shrink-0" />
              <span className="truncate">{databaseName || t('data_quality.profile_database_missing')}</span>
            </span>
          </div>
        </div>

        <TabsContent value="overview" className="m-0 min-h-0 flex-1 p-0">
          <div className="flex h-full flex-col px-6 pb-1.5">
            <DqProfileOverview
              profile={profile}
              ruleSetNames={profile.sources.map((s) => {
                const rs = ruleSets.find((r) => r.ruleSet.id === s.ruleSetId)?.ruleSet
                return rs ? localized(rs.name, i18n.language) : localized(s.ruleSetRef?.label, i18n.language) || s.ruleSetId
              })}
              checkCount={runChecks.length}
              databaseName={databaseName}
              canWrite={canWrite}
              onEdit={() => setEditOpen(true)}
              onEditReadme={() => { setReadmeEditing(true); setActiveTab('readme') }}
              onSeeLicense={() => setActiveTab('license')}
              onPickChecks={() => setActiveTab('checks')}
            />
          </div>
        </TabsContent>

        <TabsContent value="readme" className="m-0 min-h-0 flex-1 p-0">
          <div className="flex h-full flex-col px-6 pb-1.5">
            <EntityReadmePanel
              key={readmeEditing ? 'edit' : 'view'}
              initialMode={readmeEditing ? 'edit' : 'view'}
              readme={profile.readme}
              onSave={(readme) => updateProfile(profile.id, { readme })}
              canEdit={canWrite}
              attachmentOwner={{ type: 'dq-profile', id: profile.id, workspaceId: profile.workspaceId }}
              showTitle={false}
            />
          </div>
        </TabsContent>

        <TabsContent value="license" className="m-0 min-h-0 flex-1 p-0">
          <div className="flex h-full flex-col px-6 pb-1.5">
            <DqProfileLicense profile={profile} />
          </div>
        </TabsContent>

        <TabsContent value="versioning" className="m-0 min-h-0 flex-1 p-0">
          <div className="flex h-full min-h-0 w-full flex-col px-6 py-6">
            <GitRepositoryTab
              gitRemote={profile.gitRemoteConfig ?? null}
              onSave={(cfg) => updateProfile(profile.id, { gitRemoteConfig: cfg ?? undefined })}
              syncScope="dq-profiles"
              syncId={profile.id}
              onReinstall={canReinstall ? makeReinstall('dq-profiles', profile, profile.workspaceId) : undefined}
            />
          </div>
        </TabsContent>

        {/* Checks, Results and Investigation stay mounted (hidden when inactive)
            so their state — selection, report, the query being written —
            survives switching tabs. */}
        <div
          className={cn(
            'min-h-0 flex-1 overflow-hidden',
            activeTab !== 'investigate' && 'border-t',
            activeTab !== 'checks' && activeTab !== 'results' && activeTab !== 'investigate' && 'hidden',
          )}
        >
          <div className={cn('h-full', activeTab !== 'checks' && 'hidden')}>
            <DqProfileChecksTab profile={profile} ruleSets={ruleSets} dataSourceId={runnableSourceId} onInvestigate={handleInvestigate} />
          </div>
          <div className={cn('h-full', activeTab !== 'investigate' && 'hidden')}>
            {runnableSourceId ? (
              <DatabaseSqlTab
                key={investigation?.n ?? 0}
                dataSourceId={runnableSourceId}
                draftKey={`dq-profile:${profile.id}`}
                initialSql={investigation?.sql}
                runOnMount={!!investigation}
              />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">{t('data_quality.profile_database_missing')}</p>
            )}
          </div>
          <div className={cn('h-full', activeTab !== 'results' && 'hidden')}>
            <DqResultsView
              runKind="dq_profile"
              runKey={profile.id}
              runLabel={t('data_quality.profile_job_label', { name: localized(profile.name, i18n.language) })}
              dataSourceId={runnableSourceId}
              checks={runChecks}
              history={history}
              onScanComplete={handleScanComplete}
              onServerRunDone={handleServerRunDone}
              onBeforeScan={() => ensureMounted(runnableSourceId)}
              onInvestigate={handleInvestigate}
            />
          </div>
        </div>
      </Tabs>
      {editOpen && <CreateDqProfileDialog open onOpenChange={setEditOpen} editingProfile={profile} />}
    </div>
  )
}

function DqProfileOverview({
  profile,
  ruleSetNames,
  checkCount,
  databaseName,
  canWrite,
  onEdit,
  onEditReadme,
  onSeeLicense,
  onPickChecks,
}: {
  profile: DqProfile
  ruleSetNames: string[]
  checkCount: number
  databaseName: string
  canWrite: boolean
  onEdit: () => void
  onEditReadme: () => void
  onSeeLicense: () => void
  onPickChecks: () => void
}) {
  const { t, i18n } = useTranslation()
  const { resolveAttachmentUrls } = useReadmeAttachments('dq-profile', profile.id, profile.workspaceId)
  const workspace = useWorkspaceStore((s) => s._workspacesRaw.find((w) => w.id === profile.workspaceId))
  const readme = localized(profile.readme, i18n.language)
  const description = localized(profile.description, i18n.language)

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-h-0 flex-col rounded-xl border bg-card p-5 pr-2 shadow-sm">
        <div className="flex shrink-0 items-center justify-between pr-3">
          <div className="flex items-center gap-2">
            <FileText size={14} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">{t('common.readme')}</h3>
          </div>
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={onEditReadme}>
            <Pencil size={12} />
            {t('common.edit')}
          </Button>
        </div>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-3">
          {readme.trim() ? (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReadmeMarkdown>{resolveAttachmentUrls(readme)}</ReadmeMarkdown>
            </div>
          ) : (
            <button type="button" onClick={onEditReadme} className="text-sm text-muted-foreground underline-offset-2 hover:underline">
              {t('data_quality.profile_readme_empty_hint')}
            </button>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-4 self-start rounded-xl border bg-card p-5 pb-0 shadow-sm">
        <div className="flex items-center gap-2">
          <ClipboardCheck size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('databases.detail_about')}</h3>
          {canWrite && (
            <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-2 text-xs" onClick={onEdit}>
              <Pencil size={12} />
              {t('common.edit')}
            </Button>
          )}
        </div>
        {description && <p className="text-xs break-words text-muted-foreground">{description}</p>}
        {!!profile.badges?.length && <BadgeStrip badges={profile.badges} />}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Database size={12} className="shrink-0" />
          <span className="truncate">{databaseName || t('data_quality.profile_database_missing')}</span>
        </p>
        <div className="space-y-1">
          <button type="button" onClick={onPickChecks} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ShieldCheck size={12} className="shrink-0" />
            {t('data_quality.profile_summary', {
              count: checkCount,
              ruleSets: t('data_quality.profile_rule_set_count', { count: ruleSetNames.length }),
            })}
          </button>
          {ruleSetNames.length > 0 && (
            <ul className="ml-5 list-disc space-y-0.5 text-xs text-muted-foreground">
              {ruleSetNames.map((name, i) => <li key={i} className="truncate">{name}</li>)}
            </ul>
          )}
        </div>
        {profile.version && (
          <div className="flex">
            <Badge variant="outline" className="font-mono">v{profile.version}</Badge>
          </div>
        )}
        <CardMetaFooter
          className="-mt-1"
          stacked
          createdById={profile.createdById}
          createdBy={profile.createdBy}
          createdByDetails={profile.createdByDetails}
          organizationId={profile.organization ? undefined : workspace?.organizationId}
          organization={profile.organization}
          createdAt={profile.createdAt}
          updatedAt={profile.updatedAt}
          license={profile.license}
          showLicenseWhenEmpty
          onOpenLicense={onSeeLicense}
        />
      </div>
    </div>
  )
}

function DqProfileLicense({ profile }: { profile: DqProfile }) {
  const { i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('data-quality:write')
  const updateProfile = useDqProfileStore((s) => s.updateProfile)
  const workspace = useWorkspaceStore((s) => s._workspacesRaw.find((w) => w.id === profile.workspaceId))
  const org = useOrganizationStore((s) => (workspace?.organizationId ? s.getOrganization(workspace.organizationId) : undefined))
  const holder = profile.organization?.name ?? org?.name

  return (
    <EntityLicensePanel
      license={profile.license ?? null}
      onSave={(license) => updateProfile(profile.id, { license: license ?? undefined })}
      canEdit={canWrite}
      copyrightHolder={holder ? localized(holder, i18n.language) : undefined}
      showTitle={false}
    />
  )
}
