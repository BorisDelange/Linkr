import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import {
  subscribeSeedProgress,
  getSeedProgress,
  estimateRemainingMs,
  type SeedProgress,
} from '@/lib/seed-progress'

/** Coarse enough to stay honest: a countdown to the second would only ever be wrong. */
function formatRemaining(ms: number, t: ReturnType<typeof useTranslation>['t']): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds <= 10) return t('boot.remaining_seconds')
  if (seconds < 60) return t('boot.remaining_under_minute', { count: Math.ceil(seconds / 10) * 10 })
  return t('boot.remaining_minutes', { count: Math.ceil(seconds / 60) })
}

/**
 * Full-page boot screen: what is loading, how far in, and roughly how much is left.
 *
 * A first visit downloads tens of MB (bundled content, then DuckDB's wasm) before
 * the app can show anything real, so this stays up until the whole first run is
 * finished — the shell used to appear while its content was still being written,
 * which read as an app that had loaded empty.
 */
export function BootScreen({ stage }: { stage: 'stores' | 'seed' }) {
  const { t } = useTranslation()
  const progress = useSyncExternalStore<SeedProgress>(subscribeSeedProgress, getSeedProgress)

  // Driven by the seed's own state rather than by `stage`: phase 1 runs while the
  // stores are still loading, so keying the bar off the stage left the longest
  // part of a first run — hundreds of sequential fetches — with nothing to show.
  const counted = progress.total > 0 && progress.phase !== 'done'
  const percent = counted ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null
  const remainingMs = counted ? estimateRemainingMs(progress) : null

  const heading = progress.phase === 'structure'
    ? t('boot.installing_content')
    : progress.phase === 'data'
      ? t('boot.installing_data')
      : stage === 'stores'
        ? t('boot.preparing')
        : t('boot.installing_content')

  return (
    // Everything paints at once. React replaces the inline splash in #root as soon
    // as it mounts, so a delayed panel here is a white screen for as long as the
    // delay lasts — and this screen also covers the first-run seed, which is
    // nothing like brief. A short wait showing a spinner is far better than a
    // long one showing nothing.
    <div className="flex h-screen w-screen items-center justify-center bg-background">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 px-6">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />

        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-sm font-medium">{heading}</p>
          {/* The seed's own step (entity kind · id) whenever there is one: it
              changes often enough to show the app is working, which a static line
              cannot. The fallback says what this screen is, without claiming it is
              a first run — it shows on every load, briefly once installed. */}
          <p className="h-4 text-xs text-muted-foreground">
            {progress.label || t('boot.subtitle')}
          </p>
        </div>

        {percent !== null && (
          <div className="flex w-full flex-col gap-1.5">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={heading}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{t('boot.step_count', { done: progress.done, total: progress.total })}</span>
              <span>{remainingMs !== null ? formatRemaining(remainingMs, t) : `${percent}%`}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
