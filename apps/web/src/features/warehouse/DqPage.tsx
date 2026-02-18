import { useParams } from 'react-router'
import { DqRuleSetListPage } from './data-quality/DqRuleSetListPage'
import { DqRuleSetDetailPage } from './data-quality/DqRuleSetDetailPage'

export function DqPage() {
  const { ruleSetId } = useParams()

  if (ruleSetId) {
    return <DqRuleSetDetailPage ruleSetId={ruleSetId} />
  }

  return <DqRuleSetListPage />
}
