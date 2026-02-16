/** Unique identifier for each shortcut action */
export type ShortcutActionId =
  | 'toggle_sidebar'
  | 'toggle_terminal'
  | 'new_file'
  | 'save_file'
  | 'run_selection_or_line'
  | 'run_file'
  | 'toggle_comment'
  | 'find'
  | 'replace'
  | 'undo'
  | 'redo'
  | 'clear_terminal'

/** Where the shortcut fires */
export type ShortcutScope = 'global' | 'editor' | 'monaco-builtin'

/** Platform-independent key combination */
export interface KeyCombo {
  key: string // e.g. 'Enter', 'b', 's', '`', 'k'
  ctrlOrMeta: boolean // Cmd on Mac, Ctrl on Win/Linux
  shift: boolean
  alt: boolean
}

/** Full shortcut definition */
export interface ShortcutDefinition {
  id: ShortcutActionId
  labelKey: string // i18n key
  scope: ShortcutScope
  defaultBinding: KeyCombo
  binding: KeyCombo // current (custom or default)
}

function kb(
  key: string,
  opts: { shift?: boolean; alt?: boolean } = {}
): KeyCombo {
  return {
    key,
    ctrlOrMeta: true,
    shift: opts.shift ?? false,
    alt: opts.alt ?? false,
  }
}

export const DEFAULT_SHORTCUTS: Record<
  ShortcutActionId,
  Omit<ShortcutDefinition, 'binding'>
> = {
  toggle_sidebar: {
    id: 'toggle_sidebar',
    labelKey: 'shortcuts.toggle_sidebar',
    scope: 'global',
    defaultBinding: kb('b'),
  },
  toggle_terminal: {
    id: 'toggle_terminal',
    labelKey: 'shortcuts.toggle_terminal',
    scope: 'global',
    defaultBinding: kb('`'),
  },
  new_file: {
    id: 'new_file',
    labelKey: 'shortcuts.new_file',
    scope: 'global',
    defaultBinding: kb('n'),
  },
  clear_terminal: {
    id: 'clear_terminal',
    labelKey: 'shortcuts.clear_terminal',
    scope: 'global',
    defaultBinding: kb('k'),
  },
  save_file: {
    id: 'save_file',
    labelKey: 'shortcuts.save_file',
    scope: 'editor',
    defaultBinding: kb('s'),
  },
  run_selection_or_line: {
    id: 'run_selection_or_line',
    labelKey: 'shortcuts.run_selection_or_line',
    scope: 'editor',
    defaultBinding: kb('Enter'),
  },
  run_file: {
    id: 'run_file',
    labelKey: 'shortcuts.run_file',
    scope: 'editor',
    defaultBinding: kb('Enter', { shift: true }),
  },
  toggle_comment: {
    id: 'toggle_comment',
    labelKey: 'shortcuts.toggle_comment',
    scope: 'editor',
    defaultBinding: kb('c', { shift: true }),
  },
  find: {
    id: 'find',
    labelKey: 'shortcuts.find',
    scope: 'monaco-builtin',
    defaultBinding: kb('f'),
  },
  replace: {
    id: 'replace',
    labelKey: 'shortcuts.replace',
    scope: 'monaco-builtin',
    defaultBinding: kb('h'),
  },
  undo: {
    id: 'undo',
    labelKey: 'shortcuts.undo',
    scope: 'monaco-builtin',
    defaultBinding: kb('z'),
  },
  redo: {
    id: 'redo',
    labelKey: 'shortcuts.redo',
    scope: 'monaco-builtin',
    defaultBinding: kb('z', { shift: true }),
  },
}

/** Display order for the shortcut groups in the settings dialog */
export const SHORTCUT_GROUPS: {
  titleKey: string
  actions: ShortcutActionId[]
}[] = [
  {
    titleKey: 'shortcuts.general',
    actions: ['toggle_sidebar', 'toggle_terminal', 'new_file'],
  },
  {
    titleKey: 'shortcuts.editor',
    actions: [
      'save_file',
      'run_selection_or_line',
      'run_file',
      'toggle_comment',
      'undo',
      'redo',
      'find',
      'replace',
    ],
  },
  {
    titleKey: 'shortcuts.terminal',
    actions: ['clear_terminal'],
  },
]

/** Browser-reserved combos that cannot be reliably intercepted */
export const BROWSER_RESERVED: KeyCombo[] = [
  { key: 'w', ctrlOrMeta: true, shift: false, alt: false },
  { key: 't', ctrlOrMeta: true, shift: false, alt: false },
  { key: 'q', ctrlOrMeta: true, shift: false, alt: false },
  { key: 'l', ctrlOrMeta: true, shift: false, alt: false },
]
