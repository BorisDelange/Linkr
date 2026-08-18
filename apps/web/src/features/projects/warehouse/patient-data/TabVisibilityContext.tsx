import { createContext, useContext } from 'react'

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
