import { describe, it, expect } from 'vitest'
import { shouldIgnoreNotebookShortcut, type ShortcutTargetInfo } from './notebook-shortcuts'

const target = (over: Partial<ShortcutTargetInfo> = {}): ShortcutTargetInfo => ({
  tagName: 'DIV',
  isContentEditable: false,
  inDialog: false,
  ...over,
})

describe('shouldIgnoreNotebookShortcut', () => {
  it('ignores keystrokes typed into an input', () => {
    // The reported bug: "a" in the Environments dialog added a notebook cell,
    // because a/b/d are bare letters in the Jupyter preset.
    expect(shouldIgnoreNotebookShortcut(target({ tagName: 'INPUT' }))).toBe(true)
  })

  it('ignores textarea and select', () => {
    expect(shouldIgnoreNotebookShortcut(target({ tagName: 'TEXTAREA' }))).toBe(true)
    expect(shouldIgnoreNotebookShortcut(target({ tagName: 'SELECT' }))).toBe(true)
  })

  it('ignores a contenteditable region', () => {
    expect(shouldIgnoreNotebookShortcut(target({ isContentEditable: true }))).toBe(true)
  })

  it('ignores anything inside a dialog, field or not', () => {
    // A dialog's buttons are not text entry, but a bare letter there is still
    // not meant for the notebook behind it.
    expect(shouldIgnoreNotebookShortcut(target({ tagName: 'BUTTON', inDialog: true }))).toBe(true)
  })

  it('does NOT ignore the notebook itself', () => {
    // A cell header or the page body must still take the shortcut, or the
    // feature would be disabled entirely.
    expect(shouldIgnoreNotebookShortcut(target())).toBe(false)
    expect(shouldIgnoreNotebookShortcut(target({ tagName: 'BODY' }))).toBe(false)
  })

  it('matches the tag case-insensitively', () => {
    // getAttribute-style lowercase names must not slip through.
    expect(shouldIgnoreNotebookShortcut(target({ tagName: 'input' }))).toBe(true)
  })
})
