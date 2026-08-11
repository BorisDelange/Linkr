import { describe, expect, it } from 'vitest'
import {
  EMPTY_SELECTION,
  actionTargets,
  pruneSelection,
  selectOnClick,
  type Selection,
  actionableTargets,
  isRowInBulkSelection,
} from './tree-selection'

const VISIBLE = ['a', 'b', 'c', 'd', 'e']

describe('selectOnClick', () => {
  it('a plain click selects one row and anchors there', () => {
    const s = selectOnClick(EMPTY_SELECTION, 'c', VISIBLE)
    expect(s.ids).toEqual(['c'])
    expect(s.anchorId).toBe('c')
  })

  it('a plain click collapses a multi-selection to the clicked row', () => {
    const many: Selection = { ids: ['a', 'b', 'c'], anchorId: 'a' }
    expect(selectOnClick(many, 'e', VISIBLE).ids).toEqual(['e'])
  })

  it('cmd-click adds a row without losing the others', () => {
    let s = selectOnClick(EMPTY_SELECTION, 'a', VISIBLE)
    s = selectOnClick(s, 'c', VISIBLE, { meta: true })
    expect(s.ids).toEqual(['a', 'c'])
  })

  it('keeps the FIRST clicked file in the selection as more are cmd-clicked', () => {
    // The row styling reads membership from here, and the first file clicked is
    // also the one open in the editor — it must still count as selected, or the
    // anchor of the user's own selection looks excluded from it.
    let s = selectOnClick(EMPTY_SELECTION, 'a', VISIBLE)
    s = selectOnClick(s, 'c', VISIBLE, { meta: true })
    s = selectOnClick(s, 'e', VISIBLE, { meta: true })
    expect(s.ids).toContain('a')
    expect(s.ids).toEqual(['a', 'c', 'e'])
  })

  it('cmd-click on a selected row removes it', () => {
    const s = selectOnClick({ ids: ['a', 'b'], anchorId: 'a' }, 'a', VISIBLE, { meta: true })
    expect(s.ids).toEqual(['b'])
  })

  it('shift-click selects the range in VISIBLE order, both directions', () => {
    const down = selectOnClick({ ids: ['b'], anchorId: 'b' }, 'd', VISIBLE, { shift: true })
    expect(down.ids).toEqual(['b', 'c', 'd'])

    const up = selectOnClick({ ids: ['d'], anchorId: 'd' }, 'b', VISIBLE, { shift: true })
    expect(up.ids).toEqual(['b', 'c', 'd'])
  })

  it('keeps the anchor so a second shift-click can shrink the range', () => {
    // The reason the anchor is tracked separately: moving it with every click
    // makes the range creep instead of pivoting about a fixed origin.
    let s = selectOnClick(EMPTY_SELECTION, 'b', VISIBLE)
    s = selectOnClick(s, 'e', VISIBLE, { shift: true })
    expect(s.ids).toEqual(['b', 'c', 'd', 'e'])
    s = selectOnClick(s, 'c', VISIBLE, { shift: true })
    expect(s.ids).toEqual(['b', 'c'])
    expect(s.anchorId).toBe('b')
  })

  it('shift-click with no anchor behaves as a plain click', () => {
    expect(selectOnClick(EMPTY_SELECTION, 'c', VISIBLE, { shift: true }).ids).toEqual(['c'])
  })

  it('shift-click falls back to a plain click when the anchor is hidden', () => {
    // Its folder was collapsed, so the anchor is not on screen: selecting the
    // clicked row is better than selecting nothing.
    const s = selectOnClick({ ids: ['x'], anchorId: 'x' }, 'c', VISIBLE, { shift: true })
    expect(s.ids).toEqual(['c'])
    expect(s.anchorId).toBe('c')
  })

  it('a range covers only visible rows, never a collapsed folder\'s children', () => {
    // 'b' and 'd' are on screen; 'b-child' is inside a collapsed folder.
    const visible = ['a', 'b', 'd']
    const s = selectOnClick({ ids: ['a'], anchorId: 'a' }, 'd', visible, { shift: true })
    expect(s.ids).toEqual(['a', 'b', 'd'])
    expect(s.ids).not.toContain('b-child')
  })
})

describe('pruneSelection', () => {
  it('drops ids that no longer exist', () => {
    const s = pruneSelection({ ids: ['a', 'gone', 'c'], anchorId: 'a' }, VISIBLE)
    expect(s.ids).toEqual(['a', 'c'])
  })

  it('clears the anchor when it is the one that vanished', () => {
    const s = pruneSelection({ ids: ['c'], anchorId: 'gone' }, VISIBLE)
    expect(s.anchorId).toBeNull()
  })

  it('returns the same object when nothing changed, so React can skip a render', () => {
    const before: Selection = { ids: ['a', 'b'], anchorId: 'a' }
    expect(pruneSelection(before, VISIBLE)).toBe(before)
  })
})

describe('actionTargets', () => {
  it('acts on the whole selection when the click is inside it', () => {
    expect(actionTargets({ ids: ['a', 'b', 'c'], anchorId: 'a' }, 'b')).toEqual(['a', 'b', 'c'])
  })

  it('acts on the clicked row alone when it is outside the selection', () => {
    // Otherwise a menu opened on an unselected file would operate on rows
    // elsewhere in the tree, which the user cannot see from the menu.
    expect(actionTargets({ ids: ['a', 'b'], anchorId: 'a' }, 'e')).toEqual(['e'])
  })

  it('acts on the clicked row when only one thing is selected', () => {
    expect(actionTargets({ ids: ['a'], anchorId: 'a' }, 'a')).toEqual(['a'])
  })
})

describe('actionableTargets / isRowInBulkSelection', () => {
  // Folders can enter a selection: a shift-range sweeps whatever lies between two
  // visible rows. The trees' actions are file-only, so the two must agree on what
  // "a multi-selection" means — deriving them apart made a row render as selected
  // for a Delete that would silently skip it.
  const isFile = (id: string) => id.startsWith('file')

  it('drops non-actionable ids and is not bulk when one target survives', () => {
    const sel = { ids: ['file-1', 'folder-1'], anchorId: 'file-1' }
    const { ids, bulk } = actionableTargets(sel, 'file-1', isFile)
    expect(ids).toEqual(['file-1'])
    expect(bulk).toBe(false)
  })

  it('the row tint agrees: not shown as multi when only one target survives', () => {
    const sel = { ids: ['file-1', 'folder-1'], anchorId: 'file-1' }
    expect(isRowInBulkSelection(sel, 'file-1', isFile)).toBe(false)
  })

  it('is bulk, and tinted, once two actionable rows are selected', () => {
    const sel = { ids: ['file-1', 'file-2', 'folder-1'], anchorId: 'file-1' }
    const { ids, bulk } = actionableTargets(sel, 'file-1', isFile)
    expect(ids).toEqual(['file-1', 'file-2'])
    expect(bulk).toBe(true)
    expect(isRowInBulkSelection(sel, 'file-2', isFile)).toBe(true)
  })

  it('a row outside the selection is never tinted, and acts alone', () => {
    const sel = { ids: ['file-1', 'file-2'], anchorId: 'file-1' }
    expect(isRowInBulkSelection(sel, 'file-9', isFile)).toBe(false)
    expect(actionableTargets(sel, 'file-9', isFile).ids).toEqual(['file-9'])
  })
})
