import { describe, expect, it } from 'vitest'
import { isTypingTarget } from '@/lib/utils'

/**
 * Keyboard events bubble, so a container that activates on Space (a card, a drop
 * zone) sees the key AFTER any field inside it. Pressing space while typing a
 * name in a dialog "clicked" the widget around the field.
 */
const from = (tagName: string, isContentEditable = false) =>
  ({ target: { tagName, isContentEditable } as unknown as EventTarget })

describe('isTypingTarget', () => {
  it('recognises the fields a user types into', () => {
    expect(isTypingTarget(from('INPUT'))).toBe(true)
    expect(isTypingTarget(from('TEXTAREA'))).toBe(true)
    expect(isTypingTarget(from('SELECT'))).toBe(true)
  })

  it('recognises a rich-text editor', () => {
    // BlockNote/Monaco put the caret in a contentEditable or a hidden textarea.
    expect(isTypingTarget(from('DIV', true))).toBe(true)
  })

  it('lets a plain container through', () => {
    expect(isTypingTarget(from('DIV'))).toBe(false)
    expect(isTypingTarget(from('BUTTON'))).toBe(false)
  })

  it('survives an event with no usable target', () => {
    // Synthetic events and portalled content can hand over null or a non-element.
    expect(isTypingTarget({ target: null })).toBe(false)
    expect(isTypingTarget({ target: {} as EventTarget })).toBe(false)
  })
})
