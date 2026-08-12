import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { resolveTab, restorableTab } from './url-tab'

/**
 * Active tab held in the URL (`?tab=`), so a tab is shareable, bookmarkable and
 * survives reload / browser Back. The default tab writes no param, keeping the
 * canonical URL clean.
 *
 * Landing on the page with no `?tab=` reopens the tab last left on for that key,
 * instead of always snapping back to the default — in-app links (sidebar, cards)
 * build the plain URL, and always dropping the user on the first tab makes a
 * page you use tab-first tedious. An explicit `?tab=` still wins, so deep links
 * keep working.
 *
 * A restored tab is shown without rewriting the URL: doing that from an effect
 * cost a render pass and made the address bar flicker on arrival. The URL fills
 * in on the first tab click, which is also the point at which it becomes worth
 * sharing.
 *
 * The last tab is remembered in memory, not localStorage: it should survive
 * moving around the app while an entity stays open, not come back a session
 * later.
 *
 * The resolution rules live in `./url-tab` — see the ambiguity around an absent
 * `?tab=` documented there.
 */
const lastTabByKey = new Map<string, string>()

export function useUrlTab<T extends string>(options: {
  /** What the memory is scoped to, e.g. `etl:${pipelineId}`. */
  key: string
  tabs: readonly T[]
  defaultTab: T
}): [T, (tab: T) => void] {
  const { key, tabs, defaultTab } = options
  const [searchParams, setSearchParams] = useSearchParams()

  // Read on mount only: once the user acts, the memory must not override them.
  const [restored] = useState<T | null>(() => restorableTab(lastTabByKey.get(key), tabs, defaultTab))
  // Cleared on the first tab click, so a later empty `?tab=` reads as "the
  // default tab" rather than a fresh arrival — otherwise picking the default
  // tab would bounce straight back to the restored one.
  const [restorePending, setRestorePending] = useState(restored !== null)

  const { activeTab } = resolveTab<T>({
    fromUrl: searchParams.get('tab'),
    tabs,
    defaultTab,
    restored,
    restorePending,
  })

  const setActiveTab = useCallback(
    (tab: T) => {
      setRestorePending(false)
      lastTabByKey.set(key, tab)
      setSearchParams(
        (prev) => {
          if (tab === defaultTab) prev.delete('tab')
          else prev.set('tab', tab)
          return prev
        },
        { replace: true },
      )
    },
    [key, defaultTab, setSearchParams],
  )

  useEffect(() => {
    lastTabByKey.set(key, activeTab)
  }, [key, activeTab])

  return [activeTab, setActiveTab]
}
