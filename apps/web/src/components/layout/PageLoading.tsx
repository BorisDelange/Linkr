import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

/**
 * What the main area shows while a page is not ready — its chunks downloading, or
 * its route guard still resolving the workspace/project the URL names.
 *
 * One component for every route rather than a fallback written per page: the
 * sidebar reacts to the URL immediately, so anything that renders nothing in the
 * meantime reads as a page that loaded empty. On a cold visit a page pulls a few
 * MB across dozens of chunks, which is far too long to leave unexplained.
 */
export function PageLoading() {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <Loader2 size={24} className="animate-spin text-muted-foreground" />
      {/* A spinner that flashes for 80ms on a cached chunk is noise, so the text
          fades in only once the wait is long enough to be worth naming. A delayed
          CSS animation does that without a timer and a re-render. */}
      <p className="animate-in fade-in text-xs text-muted-foreground opacity-0 [animation-delay:400ms] [animation-duration:200ms] [animation-fill-mode:forwards]">
        {t('boot.loading_page')}
      </p>
    </div>
  )
}
