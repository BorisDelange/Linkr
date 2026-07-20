import { useCallback, useState } from 'react'
import type { VersioningTab } from './VersioningTabs'

const KEY = 'linkr:versioning-tab'

/**
 * Remember which versioning sub-tab (Export / Git) the user last had open, per
 * scope, so returning to a project's or workspace's Versioning page reopens the
 * tab they left on instead of always snapping back to Export. An explicit `?tab=`
 * in the URL still wins (deep links / the "open on Git" affordance) — pass it as
 * `forced`. Persisted in localStorage so it survives reloads and page remounts.
 */
export function useRememberedVersioningTab(
  scope: string,
  forced?: VersioningTab | null,
): { initialTab: VersioningTab; onTabChange: (tab: VersioningTab) => void } {
  const storageKey = `${KEY}:${scope}`
  const [initialTab] = useState<VersioningTab>(() => {
    if (forced) return forced
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null
    return saved === 'git' ? 'git' : 'export'
  })
  const onTabChange = useCallback(
    (tab: VersioningTab) => {
      try {
        localStorage.setItem(storageKey, tab)
      } catch {
        /* storage unavailable (private mode) — remembering is best-effort */
      }
    },
    [storageKey],
  )
  return { initialTab, onTabChange }
}
