import { createContext, useContext, useMemo, useRef } from 'react'

/**
 * Whether the tab a widget lives in is the one on screen.
 *
 * Keep-alive leaves visited tabs mounted so returning to them is instant. But a
 * patient widget refetches whenever the selected patient or visit changes, and a
 * mounted-but-hidden widget would run that query too — so paging through patients
 * on a board with several tabs multiplies warehouse queries by the number of
 * tabs visited. Widgets read this to skip the fetch while hidden and catch up
 * when revealed.
 *
 * Defaults to true: a widget rendered outside a tab wrapper (the editor preview,
 * the add dialog) is always visible.
 */
export const TabVisibilityContext = createContext(true)

export function useTabVisible() {
  return useContext(TabVisibilityContext)
}

const ids = new WeakMap<object, number>()
let lastId = 0

/** A stable number for an object, to name it in a load key. */
export function identity(value: object | null | undefined): number {
  if (!value) return 0
  let id = ids.get(value)
  if (id == null) {
    id = ++lastId
    ids.set(value, id)
  }
  return id
}

/**
 * What a widget last finished loading. Its load effect runs again when its tab
 * is revealed — to catch up on a patient picked while it was hidden — and was
 * reloading what it already showed, throwing away the selected note, the zoom.
 * The effect names its inputs in a key, skips a key already loaded, and marks
 * it once the rows are on screen: a load cut short by leaving the tab runs again.
 */
export function useLoadedKey() {
  const loaded = useRef<string | null>(null)
  return useMemo(() => ({
    has: (key: string) => loaded.current === key,
    set: (key: string) => { loaded.current = key },
  }), [])
}
