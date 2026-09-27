import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { FileQuestion, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'

type EntityNotFoundProps = {
  /** What couldn't be found, e.g. "Dashboard" (already translated). */
  entityLabel: string
  /** The id from the URL that didn't resolve (shown so the user sees which one). */
  entityId?: string
  /** Label for the back button (already translated), e.g. "Back to dashboards". */
  backLabel: string
} & ({ backTo: string; onBack?: never } | { onBack: () => void; backTo?: never })

/**
 * The one "not found" state for a URL pointing at a missing or deleted entity:
 * same icon, type scale and way back on every detail page.
 */
export function EntityNotFound({ entityLabel, entityId, backLabel, backTo, onBack }: EntityNotFoundProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <FileQuestion size={24} className="text-muted-foreground" />
        </div>
        <p className="mt-4 text-sm font-medium text-foreground">
          {t('common.entity_not_found_title', { entity: entityLabel })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{t('common.entity_not_found_description')}</p>
        {entityId && <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{entityId}</p>}
        <Button
          variant="outline"
          size="sm"
          className="mt-4 gap-1.5"
          onClick={() => (onBack ? onBack() : navigate(backTo!))}
        >
          <ArrowLeft size={14} />
          {backLabel}
        </Button>
      </div>
    </div>
  )
}
