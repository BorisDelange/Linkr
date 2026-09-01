/**
 * Should a notebook keyboard shortcut fire for this event?
 *
 * Jupyter's command-mode shortcuts are BARE letters (a = insert above, b =
 * insert below, d = delete), which means a window-level handler sees them from
 * every text field in the app: typing "a" in a dialog's input was adding a cell
 * to the notebook behind it.
 */

/** Elements that swallow plain typing — a keystroke here is text, not a command. */
const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** What the handler needs to know about the event's target, DOM-free so the
 *  rule can be tested without a browser environment. */
export interface ShortcutTargetInfo {
  /** Uppercase tag name of the target, e.g. 'INPUT'. */
  tagName: string
  /** The target is, or sits inside, a contenteditable region. */
  isContentEditable: boolean
  /** The target sits inside a dialog / alertdialog. */
  inDialog: boolean
}

/**
 * True when a bare-letter notebook shortcut must be ignored: the user is typing
 * into a field, or working in a dialog that is not the notebook.
 *
 * Monaco is handled separately — it has its own per-cell commands, so the
 * window handler skips it to avoid firing twice, not because it is text entry.
 */
export function shouldIgnoreNotebookShortcut(info: ShortcutTargetInfo): boolean {
  return (
    TEXT_ENTRY_TAGS.has(info.tagName.toUpperCase()) ||
    info.isContentEditable ||
    info.inDialog
  )
}

/** Read the facts above off a real event target. Returns null for a non-element
 *  target (window, document), which never carries typing. */
export function describeShortcutTarget(target: EventTarget | null): ShortcutTargetInfo | null {
  if (!target || typeof (target as Element).closest !== 'function') return null
  const el = target as HTMLElement
  return {
    tagName: el.tagName ?? '',
    isContentEditable: el.closest('[contenteditable="true"]') != null,
    inDialog: el.closest('[role="dialog"], [role="alertdialog"]') != null,
  }
}
