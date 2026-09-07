/**
 * "Where did it go?" — a newly added row or column is scrolled into view and
 * briefly highlighted.
 *
 * Adding to a 10 000-row dataset otherwise gives no feedback at all: the row lands
 * wherever the current sort puts it, quite possibly on another page, and the table
 * looks unchanged.
 *
 * The store is the one that knows what was just created, so it announces it here
 * and the table listens — the alternative was threading a callback through the
 * toolbar, the table and the store for what is a purely visual concern.
 */
import { useEffect, useState } from 'react'

export interface FlashTarget {
  fileId: string
  /** Row ordinal, for a row that was just added. */
  row?: number
  /** Column id, for a column that was just added. */
  column?: string
}

type Listener = (target: FlashTarget) => void

const listeners = new Set<Listener>()

/** Announce that something was just added, so the table can reveal it. */
export function announceAdded(target: FlashTarget): void {
  for (const listener of listeners) listener(target)
}

/** How long the highlight stays before fading, in ms. Long enough to catch the
 *  eye after a scroll, short enough not to linger as if it meant something. */
const FLASH_MS = 2000

/**
 * The row/column to highlight right now, or null.
 *
 * Callers compare against it per cell, so it is deliberately a value rather than a
 * DOM effect — the flash follows the row through a re-sort instead of decorating
 * whatever now sits at that position.
 */
export function useFlashTarget(fileId: string): FlashTarget | null {
  const [target, setTarget] = useState<FlashTarget | null>(null)

  useEffect(() => {
    const listener = (next: FlashTarget) => {
      if (next.fileId !== fileId) return
      setTarget(next)
    }
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [fileId])

  useEffect(() => {
    if (!target) return
    const timer = setTimeout(() => setTarget(null), FLASH_MS)
    return () => clearTimeout(timer)
  }, [target])

  return target
}
