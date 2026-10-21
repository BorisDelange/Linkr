import { useState } from 'react'

/**
 * Sticky latch: true from the first render where `open` is, for the life of the
 * component — so a tab's content, once mounted, stays mounted when the tab is
 * left. Set during render rather than in an effect (the documented pattern for
 * state derived from a prop change): an effect would mount the content one
 * render late, after the tab is already visible.
 */
export function useEverOpened(open: boolean): boolean {
  const [everOpened, setEverOpened] = useState(open)
  if (open && !everOpened) setEverOpened(true)
  return everOpened || open
}
