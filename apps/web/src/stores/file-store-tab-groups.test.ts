import { describe, expect, it, beforeEach } from 'vitest'
import { useFileStore, type OutputTab } from './file-store'

/**
 * Output tabs can be moved from the output (right) group to the editor (left)
 * one. Group membership is held apart from `outputTabOrder`, so each pane needs
 * its own active tab and neither may end up pointing at a tab it no longer owns.
 */

const tab = (id: string): OutputTab => ({ id, label: id, type: 'table', content: null })

const reset = (over: Partial<ReturnType<typeof useFileStore.getState>> = {}) =>
  useFileStore.setState({
    outputTabs: [tab('t1'), tab('t2'), tab('t3')],
    outputTabOrder: ['t1', 't2', 't3'],
    activeOutputTab: 't1',
    outputTabsInEditorGroup: [],
    editorGroupOutputTab: null,
    openFileIds: [],
    selectedFileId: null,
    terminalTabs: [],
    editorTabsInOutputGroup: [],
    outputGroupEditorTab: null,
    focusedGroup: 'left',
    ...over,
  })

describe('moving an output tab between groups', () => {
  beforeEach(() => reset())

  it('moves a tab left and makes it the left group active tab', () => {
    useFileStore.getState().moveOutputTabToEditorGroup('t1')
    const s = useFileStore.getState()
    expect(s.outputTabsInEditorGroup).toEqual(['t1'])
    expect(s.editorGroupOutputTab).toBe('t1')
  })

  it('hands the right group another tab when its active one leaves', () => {
    useFileStore.getState().moveOutputTabToEditorGroup('t1')
    // t1 was active on the right; the right pane must not keep pointing at it.
    expect(useFileStore.getState().activeOutputTab).toBe('t3')
  })

  it('leaves the right selection alone when a non-active tab moves', () => {
    useFileStore.getState().moveOutputTabToEditorGroup('t2')
    expect(useFileStore.getState().activeOutputTab).toBe('t1')
  })

  it('clears the right selection when the last right tab moves away', () => {
    const move = useFileStore.getState().moveOutputTabToEditorGroup
    move('t1')
    move('t2')
    move('t3')
    const s = useFileStore.getState()
    expect(s.activeOutputTab).toBeNull()
    expect(s.outputTabsInEditorGroup).toEqual(['t1', 't2', 't3'])
  })

  it('moves a tab back and re-activates it on the right', () => {
    useFileStore.getState().moveOutputTabToEditorGroup('t2')
    useFileStore.getState().moveOutputTabToOutputGroup('t2')
    const s = useFileStore.getState()
    expect(s.outputTabsInEditorGroup).toEqual([])
    expect(s.editorGroupOutputTab).toBeNull()
    expect(s.activeOutputTab).toBe('t2')
  })

  it('ignores a move the tab is already on the far side of', () => {
    const move = useFileStore.getState().moveOutputTabToEditorGroup
    move('t1')
    const after = useFileStore.getState().activeOutputTab
    move('t1')
    expect(useFileStore.getState().activeOutputTab).toBe(after)
    expect(useFileStore.getState().outputTabsInEditorGroup).toEqual(['t1'])
  })

  it('keeps the original order when a tab comes back', () => {
    // Group membership is a separate list precisely so the order survives.
    useFileStore.getState().moveOutputTabToEditorGroup('t1')
    useFileStore.getState().moveOutputTabToOutputGroup('t1')
    expect(useFileStore.getState().outputTabOrder).toEqual(['t1', 't2', 't3'])
  })
})

describe('giving the editor pane back to a file', () => {
  beforeEach(() => reset())

  it('drops the parked output when a file is selected', () => {
    useFileStore.getState().moveOutputTabToEditorGroup('t1')
    useFileStore.getState().selectFile('f1')
    // Left set, the output would keep covering the editor and the click on a
    // script tab would look ignored.
    expect(useFileStore.getState().editorGroupOutputTab).toBeNull()
    // The tab itself stays in the group, ready to be picked again.
    expect(useFileStore.getState().outputTabsInEditorGroup).toEqual(['t1'])
  })

  it('drops it when a file is opened, and when selection is cleared', () => {
    useFileStore.getState().moveOutputTabToEditorGroup('t1')
    useFileStore.getState().openFile('f2')
    expect(useFileStore.getState().editorGroupOutputTab).toBeNull()

    useFileStore.getState().setEditorGroupOutputTab('t1')
    useFileStore.getState().selectFile(null)
    expect(useFileStore.getState().editorGroupOutputTab).toBeNull()
  })

  it('drops it when a terminal tab is selected', () => {
    useFileStore.getState().moveOutputTabToEditorGroup('t1')
    useFileStore.getState().selectTerminalTab('term:bash:1')
    expect(useFileStore.getState().editorGroupOutputTab).toBeNull()
    expect(useFileStore.getState().selectedFileId).toBe('term:bash:1')
  })

  it('re-shows the output when its tab is picked again', () => {
    useFileStore.getState().moveOutputTabToEditorGroup('t1')
    useFileStore.getState().selectFile('f1')
    useFileStore.getState().setEditorGroupOutputTab('t1')
    expect(useFileStore.getState().editorGroupOutputTab).toBe('t1')
  })
})

describe('closing a tab that lives in the editor group', () => {
  beforeEach(() => reset())

  it('removes it from the group and drops the left selection', () => {
    useFileStore.getState().moveOutputTabToEditorGroup('t2')
    useFileStore.getState().closeOutputTab('t2')
    const s = useFileStore.getState()
    // Left over, the left pane would render content that no longer exists.
    expect(s.outputTabsInEditorGroup).toEqual([])
    expect(s.editorGroupOutputTab).toBeNull()
    expect(s.outputTabOrder).toEqual(['t1', 't3'])
  })

  it('falls back to another moved tab rather than emptying the pane', () => {
    const move = useFileStore.getState().moveOutputTabToEditorGroup
    move('t1')
    move('t2')
    useFileStore.getState().closeOutputTab('t2')
    const s = useFileStore.getState()
    expect(s.outputTabsInEditorGroup).toEqual(['t1'])
    expect(s.editorGroupOutputTab).toBe('t1')
  })

  it('leaves the left group untouched when a right tab closes', () => {
    useFileStore.getState().moveOutputTabToEditorGroup('t1')
    useFileStore.getState().closeOutputTab('t3')
    const s = useFileStore.getState()
    expect(s.outputTabsInEditorGroup).toEqual(['t1'])
    expect(s.editorGroupOutputTab).toBe('t1')
  })
})

describe('moving a file or terminal to the output group', () => {
  beforeEach(() => reset({ openFileIds: ['f1', 'f2', 'f3'], selectedFileId: 'f2' }))

  it('makes it the right group active tab, focused, and gives the left another file', () => {
    useFileStore.getState().moveEditorTabToOutputGroup('f2')
    const s = useFileStore.getState()
    expect(s.editorTabsInOutputGroup).toEqual(['f2'])
    expect(s.outputGroupEditorTab).toBe('f2')
    expect(s.focusedGroup).toBe('right')
    expect(s.outputVisible).toBe(true)
    // Still open: only its group changed.
    expect(s.openFileIds).toEqual(['f1', 'f2', 'f3'])
    expect(s.selectedFileId).toBe('f3')
  })

  it('selecting a file that lives on the right activates it there, not on the left', () => {
    useFileStore.getState().moveEditorTabToOutputGroup('f1')
    useFileStore.getState().selectFile('f2')
    useFileStore.getState().selectFile('f1')
    const s = useFileStore.getState()
    expect(s.selectedFileId).toBe('f2')
    expect(s.outputGroupEditorTab).toBe('f1')
    expect(s.focusedGroup).toBe('right')
  })

  it('an output becoming active on the right takes the pane back', () => {
    useFileStore.getState().moveEditorTabToOutputGroup('f1')
    useFileStore.getState().setActiveOutputTab('t2')
    expect(useFileStore.getState().outputGroupEditorTab).toBeNull()
  })

  it('an output activated in the left group leaves the right file shown', () => {
    useFileStore.getState().moveOutputTabToEditorGroup('t2')
    useFileStore.getState().moveEditorTabToOutputGroup('f1')
    useFileStore.getState().setActiveOutputTab('t2')
    expect(useFileStore.getState().outputGroupEditorTab).toBe('f1')
  })

  it('a reused output living on the left is re-shown there, never in the right pane', () => {
    useFileStore.getState().moveOutputTabToEditorGroup('t2')
    useFileStore.getState().selectFile('f2')
    // A re-run upserts the same tab and activates it.
    useFileStore.getState().addOutputTab(tab('t2'))
    useFileStore.getState().setActiveOutputTab('t2')
    const s = useFileStore.getState()
    expect(s.editorGroupOutputTab).toBe('t2')
    expect(s.activeOutputTab).not.toBe('t2')
  })

  it('closing the right file hands the right group the tab before it', () => {
    const move = useFileStore.getState().moveEditorTabToOutputGroup
    move('f1')
    move('f3')
    useFileStore.getState().closeFile('f3')
    const s = useFileStore.getState()
    expect(s.editorTabsInOutputGroup).toEqual(['f1'])
    expect(s.outputGroupEditorTab).toBe('f1')
    expect(s.selectedFileId).toBe('f2')
  })

  it('closing the left file never selects one that lives on the right', () => {
    useFileStore.getState().moveEditorTabToOutputGroup('f1')
    useFileStore.getState().selectFile('f2')
    useFileStore.getState().closeFile('f2')
    expect(useFileStore.getState().selectedFileId).toBe('f3')
    useFileStore.getState().closeFile('f3')
    expect(useFileStore.getState().selectedFileId).toBeNull()
  })

  it('moving it back makes it the left active tab again', () => {
    useFileStore.getState().moveEditorTabToOutputGroup('f1')
    useFileStore.getState().moveEditorTabToEditorGroup('f1')
    const s = useFileStore.getState()
    expect(s.editorTabsInOutputGroup).toEqual([])
    expect(s.outputGroupEditorTab).toBeNull()
    expect(s.selectedFileId).toBe('f1')
    expect(s.focusedGroup).toBe('left')
  })

  it('moves a terminal the same way, and closing it cleans the group', () => {
    reset({
      openFileIds: ['f1'],
      selectedFileId: 'term:r:1',
      terminalTabs: [{ id: 'term:r:1', kind: 'r', label: 'R 1' }],
    })
    useFileStore.getState().moveEditorTabToOutputGroup('term:r:1')
    let s = useFileStore.getState()
    expect(s.outputGroupEditorTab).toBe('term:r:1')
    expect(s.selectedFileId).toBe('f1')
    expect(s.openFileIds).toEqual(['f1'])
    useFileStore.getState().closeTerminalTab('term:r:1')
    s = useFileStore.getState()
    expect(s.editorTabsInOutputGroup).toEqual([])
    expect(s.outputGroupEditorTab).toBeNull()
  })

})
