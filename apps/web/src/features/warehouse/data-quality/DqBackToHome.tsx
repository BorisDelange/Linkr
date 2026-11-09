import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { paths } from '@/lib/paths'

/** Back to the Data quality home, above the rule set and profile lists. */
export function DqBackToHome({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <button
      onClick={() => navigate(paths.warehouseDataQuality(workspaceId))}
      className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft size={13} />
      {t('common.back')}
    </button>
  )
}
