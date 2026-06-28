import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { FileQuestion, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface EntityNotFoundProps {
  /** What couldn't be found, e.g. "Project" / "Workspace" (already translated). */
  entityLabel: string
  /** The id from the URL that didn't resolve (shown so the user sees which one). */
  entityId?: string
  /** Path to navigate back to (the parent page). */
  backTo: string
  /** Label for the back button (already translated). */
  backLabel: string
}

/** Centered "entity not found" state for a URL that points at a missing/deleted entity. */
export function EntityNotFound({ entityLabel, entityId, backTo, backLabel }: EntityNotFoundProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
          <FileQuestion size={24} className="text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">
          {t('common.entity_not_found_title', { entity: entityLabel })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('common.entity_not_found_description')}
          {entityId && <span className="mt-1 block font-mono text-xs">{entityId}</span>}
        </p>
        <Button variant="outline" size="sm" className="mt-5 gap-1.5" onClick={() => navigate(backTo)}>
          <ArrowLeft size={14} />
          {backLabel}
        </Button>
      </div>
    </div>
  )
}
