import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'

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
 * The last tab is remembered in memory, not localStorage: it should survive
 * moving around the app while an entity stays open, not come back a session
 * later.
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

  const isTab = useCallback(
    (value: string | null | undefined): value is T => !!value && (tabs as readonly string[]).includes(value),
    [tabs],
  )

  // Seeds the first render only. Re-reading the remembered tab on later renders
  // would fight the URL once the user goes back to the default tab, which
  // deliberately clears the param.
  const [remembered] = useState<T>(() => {
    const saved = lastTabByKey.get(key)
    return saved && (tabs as readonly string[]).includes(saved) ? (saved as T) : defaultTab
  })

  const fromUrl = searchParams.get('tab')
  const activeTab = isTab(fromUrl) ? fromUrl : remembered

  const setActiveTab = useCallback(
    (tab: T) => {
      setSearchParams(
        (prev) => {
          if (tab === defaultTab) prev.delete('tab')
          else prev.set('tab', tab)
          return prev
        },
        { replace: true },
      )
    },
    [defaultTab, setSearchParams],
  )

  // Reflect a remembered non-default tab in the URL, so the address bar matches
  // what is on screen and a reload stays on it.
  useEffect(() => {
    if (activeTab !== defaultTab && !isTab(fromUrl)) {
      setSearchParams(
        (prev) => {
          prev.set('tab', activeTab)
          return prev
        },
        { replace: true },
      )
    }
  }, [activeTab, defaultTab, fromUrl, isTab, setSearchParams])

  useEffect(() => {
    lastTabByKey.set(key, activeTab)
  }, [key, activeTab])

  return [activeTab, setActiveTab]
}
