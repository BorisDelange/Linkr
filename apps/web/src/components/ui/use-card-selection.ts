import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nextSelection, type RowKey } from '@/components/ui/data-table'

export interface CardSelection {
  /** Keys currently selected. Empty when selection mode is off. */
  selected: Set<RowKey>
  /** True while at least one card is selected — the grid is in selection mode. */
  active: boolean
  /** Number of selected cards, for the toolbar button and the confirm dialog. */
  count: number
  /**
   * Card click handler. Returns true when the click was consumed as a selection
   * gesture, so the caller skips its navigation:
   *
   *   onClick={(e) => { if (!selection.onCardClick(e, id)) navigate(id) }}
   */
  onCardClick: (e: ClickMods, key: RowKey) => boolean
  isSelected: (key: RowKey) => boolean
  clear: () => void
  /** The selected keys in the grid's own order, for a bulk action. */
  orderedSelection: () => RowKey[]
}

/**
 * Cmd/Ctrl-click multi-selection for a card grid, sharing the file-explorer
 * maths (`nextSelection`) with the shared data table so both read the same way:
 * Cmd/Ctrl toggles one card, Shift extends from the anchor — or, before any
 * card was picked, from the first card, as if it were selected.
 *
 * A plain click is deliberately NOT a selection gesture here — on a card grid it
 * stays navigation. Selection therefore only ever starts with a modifier, and a
 * plain click on a selected card still opens it. `keys` must be the filtered,
 * sorted order the user sees, so Shift-ranges follow the visible grid; keys that
 * leave the grid (filtered out, deleted) drop out of the selection.
 */
/** Modifier state of a card click, as read from the mouse event. */
export interface ClickMods { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }

/** Whether a card click is a selection gesture rather than navigation. */
export function isSelectionClick(e: ClickMods): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey
}

/** Where a Shift range starts: the last card picked, else the first card shown. */
export function rangeAnchor(anchor: RowKey | null, keys: readonly RowKey[]): RowKey | null {
  return anchor != null && keys.includes(anchor) ? anchor : keys[0] ?? null
}

/** Drops selected keys the grid no longer shows, preserving identity when nothing changed. */
export function retainPresent(selected: Set<RowKey>, keys: RowKey[]): Set<RowKey> {
  if (selected.size === 0) return selected
  const present = new Set(keys)
  const next = new Set([...selected].filter((k) => present.has(k)))
  return next.size === selected.size ? selected : next
}

/**
 * Where a plain click does not drop the selection: a control (the bulk action
 * acting on it, a toolbar), a field, or anything inside a dialog or menu — a
 * confirm dialog opened from the selection is portalled outside the grid.
 */
const KEEPS_SELECTION = 'button, a, input, textarea, select, label, [role="button"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [data-radix-popper-content-wrapper]'

/** Whether a click drops the selection: plain, and on nothing that acts on it. */
export function clearsSelection(e: ClickMods, target: EventTarget | null): boolean {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return false
  const el = target as { closest?: (selector: string) => unknown } | null
  return !el?.closest?.(KEEPS_SELECTION)
}

/** A press that should keep the browser's text selection: in a field. */
function inEditable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
}

export function useCardSelection(keys: RowKey[]): CardSelection {
  const [raw, setSelected] = useState<Set<RowKey>>(new Set())
  const anchorRef = useRef<RowKey | null>(null)

  // Shift-press extends the page's text selection from the last click, which
  // highlights every card in between as soon as the button goes down: stopped
  // at the press, while this grid is on screen.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.shiftKey && e.button === 0 && !inEditable(e.target)) e.preventDefault()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  const keyList = keys

  // Keys the grid no longer shows are dropped during render rather than in an
  // effect, so the count never briefly claims more than the user can see after a
  // filter change or a deletion.
  const selected = useMemo(() => retainPresent(raw, keyList), [raw, keyList])

  const clear = useCallback(() => {
    setSelected(new Set())
    anchorRef.current = null
  }, [])

  // A plain click elsewhere on the page drops the selection, as in a file
  // explorer. A plain click on a card opens it, which leaves the grid anyway.
  const hasSelection = raw.size > 0
  useEffect(() => {
    if (!hasSelection) return
    const onClick = (e: MouseEvent) => {
      if (e.button === 0 && clearsSelection(e, e.target)) clear()
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [hasSelection, clear])

  const onCardClick = useCallback(
    (e: ClickMods, key: RowKey) => {
      if (!isSelectionClick(e)) return false
      const toggle = e.metaKey || e.ctrlKey
      const range = e.shiftKey
      const anchor = range ? rangeAnchor(anchorRef.current, keyList) : anchorRef.current
      const r = nextSelection(selected, key, keyList, { toggle, range }, anchor)
      anchorRef.current = r.anchor
      setSelected(r.selection)
      window.getSelection()?.removeAllRanges()
      return true
    },
    [keyList, selected],
  )

  const isSelected = useCallback((key: RowKey) => selected.has(key), [selected])

  const orderedSelection = useCallback(
    () => keyList.filter((k) => selected.has(k)),
    [keyList, selected],
  )

  return {
    selected,
    active: selected.size > 0,
    count: selected.size,
    onCardClick,
    isSelected,
    clear,
    orderedSelection,
  }
}

/**
 * Class applied to a card while it is part of a multi-selection: greyed out and
 * ringed, so a selected card reads as "picked, pending an action" rather than as
 * the hover state a plain mouse-over already uses.
 */
export const selectedCardClass = 'bg-muted ring-2 ring-primary/60 ring-inset'
