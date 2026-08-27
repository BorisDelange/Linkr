import { useCallback, useMemo, useRef, useState } from 'react'
import { nextSelection, type RowKey } from '@/components/ui/concept-data-table'

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
 * Cmd/Ctrl toggles one card, Shift extends from the anchor.
 *
 * A plain click is deliberately NOT a selection gesture here — on a card grid it
 * stays navigation. Selection therefore only ever starts with a modifier, and a
 * plain click on a selected card still opens it. `keys` must be the filtered,
 * sorted order the user sees, so Shift-ranges follow the visible grid; keys that
 * leave the grid (filtered out, deleted) drop out of the selection.
 */
/** Modifier state of a card click, as read from the mouse event. */
export interface ClickMods { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }

/**
 * Whether a card click is a selection gesture rather than navigation. Shift
 * without an anchor is NOT one: it would "extend" from nothing and select a
 * single card, which reads as an accidental selection.
 */
export function isSelectionClick(e: ClickMods, anchor: RowKey | null): boolean {
  if (e.metaKey || e.ctrlKey) return true
  return e.shiftKey && anchor != null
}

/** Drops selected keys the grid no longer shows, preserving identity when nothing changed. */
export function retainPresent(selected: Set<RowKey>, keys: RowKey[]): Set<RowKey> {
  if (selected.size === 0) return selected
  const present = new Set(keys)
  const next = new Set([...selected].filter((k) => present.has(k)))
  return next.size === selected.size ? selected : next
}

export function useCardSelection(keys: RowKey[]): CardSelection {
  const [raw, setSelected] = useState<Set<RowKey>>(new Set())
  const anchorRef = useRef<RowKey | null>(null)

  const keyList = keys

  // Keys the grid no longer shows are dropped during render rather than in an
  // effect, so the count never briefly claims more than the user can see after a
  // filter change or a deletion.
  const selected = useMemo(() => retainPresent(raw, keyList), [raw, keyList])

  const clear = useCallback(() => {
    setSelected(new Set())
    anchorRef.current = null
  }, [])

  const onCardClick = useCallback(
    (e: ClickMods, key: RowKey) => {
      if (!isSelectionClick(e, anchorRef.current)) return false
      const toggle = e.metaKey || e.ctrlKey
      const range = e.shiftKey
      const r = nextSelection(selected, key, keyList, { toggle, range }, anchorRef.current)
      anchorRef.current = r.anchor
      setSelected(r.selection)
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
