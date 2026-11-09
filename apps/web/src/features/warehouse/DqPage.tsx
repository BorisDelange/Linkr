import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ClipboardCheck, ShieldCheck } from 'lucide-react'
import { EntryPointCard } from '@/components/ui/entry-point-card'
import { PageContainer, PageHeader } from '@/components/ui/page-header'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { paths } from '@/lib/paths'
import { useDqStore } from '@/stores/dq-store'
import { useDqProfileStore } from '@/stores/dq-profile-store'
import { DqRuleSetListPage } from './data-quality/DqRuleSetListPage'
import { DqRuleSetDetailPage } from './data-quality/DqRuleSetDetailPage'
import { DqProfileListPage } from './data-quality/DqProfileListPage'
import { DqProfileDetailPage } from './data-quality/DqProfileDetailPage'

type View = 'home' | 'rule-sets' | 'profiles'

/**
 * Data quality: a home with two entry points — the rule sets, where checks are
 * written and tested, and the quality profiles, which run a choice of them on a
 * database. A rule set keeps its short URL (`…/data-quality/:ruleSetId`).
 */
export function DqPage({ view = 'home' }: { view?: View }) {
  const { wsUid, raw } = useResolvedParams()

  if (view === 'profiles') {
    return raw.profileId ? <DqProfileDetailPage profileId={raw.profileId} /> : <DqProfileListPage />
  }
  if (raw.ruleSetId) return <DqRuleSetDetailPage ruleSetId={raw.ruleSetId} />
  if (view === 'rule-sets') return <DqRuleSetListPage />
  return wsUid ? <DqHome workspaceId={wsUid} /> : null
}

function DqHome({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { dqRuleSets, dqRuleSetsLoaded, loadDqRuleSets } = useDqStore()
  const { profiles, profilesLoaded, loadProfiles } = useDqProfileStore()

  useEffect(() => {
    if (!dqRuleSetsLoaded) void loadDqRuleSets()
  }, [dqRuleSetsLoaded, loadDqRuleSets])
  useEffect(() => {
    if (!profilesLoaded) void loadProfiles()
  }, [profilesLoaded, loadProfiles])

  return (
    <PageContainer width="3xl">
      <PageHeader title={t('data_quality.title')} description={t('data_quality.home_description')} />
      <div className="mt-8 grid grid-cols-2 gap-4">
        <EntryPointCard
          icon={ShieldCheck}
          accent="dq-rule-set"
          title={t('data_quality.rs_title')}
          description={t('data_quality.rule_sets_widget_description')}
          openLabel={t('data_quality.rule_sets_widget_open')}
          count={dqRuleSets.filter((rs) => rs.workspaceId === workspaceId).length}
          onClick={() => navigate(paths.warehouseDqRuleSets(workspaceId))}
        />
        <EntryPointCard
          icon={ClipboardCheck}
          accent="dq-profile"
          title={t('data_quality.profiles_title')}
          description={t('data_quality.profiles_widget_description')}
          openLabel={t('data_quality.profiles_widget_open')}
          count={profiles.filter((p) => p.workspaceId === workspaceId).length}
          onClick={() => navigate(paths.warehouseDqProfiles(workspaceId))}
        />
      </div>
    </PageContainer>
  )
}
