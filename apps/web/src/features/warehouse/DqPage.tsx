import { useResolvedParams } from '@/hooks/use-resolved-params'
import { DqRuleSetListPage } from './data-quality/DqRuleSetListPage'
import { DqRuleSetDetailPage } from './data-quality/DqRuleSetDetailPage'

export function DqPage() {
  const { raw } = useResolvedParams()
  const ruleSetId = raw.ruleSetId

  if (ruleSetId) {
    return <DqRuleSetDetailPage ruleSetId={ruleSetId} />
  }

  return <DqRuleSetListPage />
}
