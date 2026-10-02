import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { paths } from '@/lib/paths'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import type { ConceptCountView } from './use-concept-count'

/** The database's Concepts tab, from a project or from the workspace. */
function conceptsTabHref(wsUid: string, projectUid: string | undefined, dataSourceId: string): string {
  const db = projectUid ? paths.database(wsUid, projectUid, dataSourceId) : paths.warehouseDatabase(wsUid, dataSourceId)
  return `${db}?tab=concepts`
}

/**
 * What a view listing a database's concepts says when their counts are not
 * complete — never computed, partial, running or failed — with the way to the
 * database's Concepts tab, the one place the counting is run from.
 */
export function ConceptCountNotice({
  count,
  dataSourceId,
  className,
}: {
  count: ConceptCountView
  dataSourceId: string | undefined
  className?: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid, projectUid } = useResolvedParams()
  if (!count.enabled || !count.checked || !dataSourceId) return null

  const { live, progress } = count
  const records = live.running ? live.records : progress.records
  const patients = live.running ? live.patients : progress.patients
  const steps = t('concepts.count_steps', {
    records: records.done,
    recordsTotal: records.total,
    patients: patients.done,
    patientsTotal: patients.total,
  })

  let message: string
  let tone: 'muted' | 'error' = 'muted'
  if (live.error) {
    message = t('concepts.count_failed', { error: live.error })
    tone = 'error'
  } else if (live.running) {
    message = `${t('concepts.count_running')} — ${steps}`
  } else if (!count.exists) {
    message = t('concepts.count_none')
  } else if (progress.state !== 'complete') {
    message = `${t('concepts.count_partial')} — ${steps}`
  } else {
    return null
  }

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-b px-4 py-2',
        tone === 'error' ? 'border-destructive/30 bg-destructive/10' : 'bg-muted/40',
        className,
      )}
    >
      <span className={cn('flex items-center gap-1.5 text-xs', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
        {live.running && <Loader2 size={12} className="shrink-0 animate-spin" />}
        {message}
      </span>
      {wsUid && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 gap-1 text-xs"
          onClick={() => navigate(conceptsTabHref(wsUid, projectUid, dataSourceId))}
        >
          {t('concepts.count_open_tab')}
          <ArrowRight size={12} />
        </Button>
      )}
    </div>
  )
}
