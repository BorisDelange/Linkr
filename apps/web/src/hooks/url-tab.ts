/**
 * Tab-resolution rules behind `useUrlTab`, kept free of React so they can be
 * tested directly.
 *
 * An absent `?tab=` is ambiguous: it means both "just arrived, reopen what they
 * were last on" and "they picked the default tab, which deliberately writes no
 * param". Only the arrival case may consult the remembered tab — hence
 * `restorePending`, which the caller clears as soon as the user picks a tab.
 */

/** The tab to reopen on arrival, or null when there is nothing to restore. */
export function restorableTab<T extends string>(
  remembered: string | undefined,
  tabs: readonly T[],
  defaultTab: T,
): T | null {
  if (!remembered) return null
  if (!(tabs as readonly string[]).includes(remembered)) return null
  // The default tab writes no param, so restoring it is a no-op.
  if (remembered === defaultTab) return null
  return remembered as T
}

export function resolveTab<T extends string>(options: {
  fromUrl: string | null
  tabs: readonly T[]
  defaultTab: T
  restored: T | null
  restorePending: boolean
}): { activeTab: T } {
  const { fromUrl, tabs, defaultTab, restored, restorePending } = options
  if (fromUrl && (tabs as readonly string[]).includes(fromUrl)) {
    return { activeTab: fromUrl as T }
  }
  if (restored !== null && restorePending) {
    return { activeTab: restored }
  }
  // Either an unknown `?tab=` (fall back rather than render an empty body), or
  // the user going back to the default tab.
  return { activeTab: defaultTab }
}
