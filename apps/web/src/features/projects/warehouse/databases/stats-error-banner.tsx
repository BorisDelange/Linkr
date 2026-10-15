import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NoticeBanner } from '@/components/ui/notice-banner'
import { formatApiError } from '@/lib/api-client'
import { etlRunningDetail, stopEtlRunOnServer } from '@/lib/api/data-sources'

/** Why the statistics could not be computed. An ETL run holding the database
 *  gets its own band, with a way to stop the run: DuckDB lets nothing else open
 *  the file — reads included — until the run has let go of it. */
export function StatsErrorBanner({ dataSourceId, error, onRetry, retrying = false, className }: {
  dataSourceId: string
  error: unknown
  onRetry: () => void
  retrying?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  // Keyed by the run's start time: a stop asked of one run must not read as
  // "stopping" once a later run holds the file.
  const [stopRequestedFor, setStopRequestedFor] = useState<string | null>(null)
  const [stopError, setStopError] = useState<unknown>(null)
  const etl = etlRunningDetail(error)

  if (!etl) {
    return (
      <NoticeBanner
        tone="danger"
        className={className}
        title={t('databases.stats_failed')}
        description={formatApiError(error).summary}
        action={<RetryButton onRetry={onRetry} retrying={retrying} />}
      />
    )
  }

  const stopping = etl.stopping || stopRequestedFor === etl.startedAt
  const stopRun = async () => {
    setStopError(null)
    try {
      await stopEtlRunOnServer(dataSourceId)
      setStopRequestedFor(etl.startedAt)
    } catch (err) {
      setStopError(err)
    }
  }
  return (
    <NoticeBanner
      tone="warning"
      className={className}
      title={stopping ? t('databases.stats_etl_stopping_title') : t('databases.stats_etl_running_title')}
      description={stopError != null
        ? formatApiError(stopError).summary
        : stopping ? t('databases.stats_etl_stopping_description') : t('databases.stats_etl_running_description')}
      action={(
        <div className="flex gap-2">
          {!stopping && (
            <Button variant="outline" size="sm" onClick={() => void stopRun()} className="gap-1.5 text-xs">
              <Square size={12} />
              {t('databases.stats_etl_stop_run')}
            </Button>
          )}
          <RetryButton onRetry={onRetry} retrying={retrying} />
        </div>
      )}
    />
  )
}

/** Least time the Retry spinner shows after a click. A retry refused at once
 *  would otherwise change nothing on screen, and read as a dead button. */
const RETRY_FEEDBACK_MS = 700

function RetryButton({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useTranslation()
  const [pressed, setPressed] = useState(false)
  useEffect(() => {
    if (!pressed) return
    const timer = setTimeout(() => setPressed(false), RETRY_FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [pressed])
  const busy = retrying || pressed
  return (
    <Button
      size="sm"
      onClick={() => { setPressed(true); onRetry() }}
      disabled={busy}
      className="gap-1.5 text-xs"
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
      {t('databases.stats_retry')}
    </Button>
  )
}
