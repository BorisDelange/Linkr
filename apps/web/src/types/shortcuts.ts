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
  // R Notebook shortcuts (Rmd / Qmd)
  | 'rmd_run_chunk'
  | 'rmd_run_chunk_stay'
  | 'rmd_run_chunk_insert'
  | 'rmd_run_all'
  | 'rmd_run_above'
  | 'rmd_insert_chunk'
  | 'rmd_insert_chunk_above'
  | 'rmd_insert_chunk_below'
  | 'rmd_delete_chunk'
  | 'rmd_render'
  // Jupyter Notebook shortcuts (ipynb)
  | 'ipynb_run_chunk'
  | 'ipynb_run_chunk_stay'
  | 'ipynb_run_chunk_insert'
  | 'ipynb_run_all'
  | 'ipynb_run_above'
  | 'ipynb_insert_chunk'
  | 'ipynb_insert_chunk_above'
  | 'ipynb_insert_chunk_below'
  | 'ipynb_delete_chunk'
  | 'ipynb_render'

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
  opts: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
): KeyCombo {
  return {
    key,
    ctrlOrMeta: opts.ctrl ?? true,
    shift: opts.shift ?? false,
    alt: opts.alt ?? false,
  }
}

/** No key combo — shortcut intentionally left blank */
function bare(key: string, opts: { shift?: boolean; alt?: boolean } = {}): KeyCombo {
  return { key, ctrlOrMeta: false, shift: opts.shift ?? false, alt: opts.alt ?? false }
}

/** No binding assigned */
const NONE: KeyCombo = { key: '', ctrlOrMeta: false, shift: false, alt: false }

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

  // ── R Notebooks (Rmd / Qmd) — RStudio defaults ──
  rmd_run_chunk: {
    id: 'rmd_run_chunk',
    labelKey: 'shortcuts.nb_run_chunk',
    scope: 'editor',
    defaultBinding: kb('Enter', { shift: true }),
  },
  rmd_run_chunk_stay: {
    id: 'rmd_run_chunk_stay',
    labelKey: 'shortcuts.nb_run_chunk_stay',
    scope: 'editor',
    defaultBinding: NONE,
  },
  rmd_run_chunk_insert: {
    id: 'rmd_run_chunk_insert',
    labelKey: 'shortcuts.nb_run_chunk_insert',
    scope: 'editor',
    defaultBinding: NONE,
  },
  rmd_run_all: {
    id: 'rmd_run_all',
    labelKey: 'shortcuts.nb_run_all',
    scope: 'editor',
    defaultBinding: kb('r', { alt: true }),
  },
  rmd_run_above: {
    id: 'rmd_run_above',
    labelKey: 'shortcuts.nb_run_above',
    scope: 'editor',
    defaultBinding: kb('p', { alt: true }),
  },
  rmd_insert_chunk: {
    id: 'rmd_insert_chunk',
    labelKey: 'shortcuts.nb_insert_chunk',
    scope: 'editor',
    defaultBinding: kb('i', { alt: true }),
  },
  rmd_insert_chunk_above: {
    id: 'rmd_insert_chunk_above',
    labelKey: 'shortcuts.nb_insert_chunk_above',
    scope: 'editor',
    defaultBinding: NONE,
  },
  rmd_insert_chunk_below: {
    id: 'rmd_insert_chunk_below',
    labelKey: 'shortcuts.nb_insert_chunk_below',
    scope: 'editor',
    defaultBinding: NONE,
  },
  rmd_delete_chunk: {
    id: 'rmd_delete_chunk',
    labelKey: 'shortcuts.nb_delete_chunk',
    scope: 'editor',
    defaultBinding: NONE,
  },
  rmd_render: {
    id: 'rmd_render',
    labelKey: 'shortcuts.nb_render',
    scope: 'editor',
    defaultBinding: kb('k', { shift: true }),
  },

  // ── Jupyter Notebooks (ipynb) — Jupyter defaults ──
  ipynb_run_chunk: {
    id: 'ipynb_run_chunk',
    labelKey: 'shortcuts.nb_run_chunk',
    scope: 'editor',
    defaultBinding: bare('Enter', { shift: true }),
  },
  ipynb_run_chunk_stay: {
    id: 'ipynb_run_chunk_stay',
    labelKey: 'shortcuts.nb_run_chunk_stay',
    scope: 'editor',
    defaultBinding: kb('Enter'),
  },
  ipynb_run_chunk_insert: {
    id: 'ipynb_run_chunk_insert',
    labelKey: 'shortcuts.nb_run_chunk_insert',
    scope: 'editor',
    defaultBinding: bare('Enter', { alt: true }),
  },
  ipynb_run_all: {
    id: 'ipynb_run_all',
    labelKey: 'shortcuts.nb_run_all',
    scope: 'editor',
    defaultBinding: kb('F9'),
  },
  ipynb_run_above: {
    id: 'ipynb_run_above',
    labelKey: 'shortcuts.nb_run_above',
    scope: 'editor',
    defaultBinding: bare('F8'),
  },
  ipynb_insert_chunk: {
    id: 'ipynb_insert_chunk',
    labelKey: 'shortcuts.nb_insert_chunk',
    scope: 'editor',
    defaultBinding: NONE,
  },
  ipynb_insert_chunk_above: {
    id: 'ipynb_insert_chunk_above',
    labelKey: 'shortcuts.nb_insert_chunk_above',
    scope: 'editor',
    defaultBinding: bare('a'),
  },
  ipynb_insert_chunk_below: {
    id: 'ipynb_insert_chunk_below',
    labelKey: 'shortcuts.nb_insert_chunk_below',
    scope: 'editor',
    defaultBinding: bare('b'),
  },
  ipynb_delete_chunk: {
    id: 'ipynb_delete_chunk',
    labelKey: 'shortcuts.nb_delete_chunk',
    scope: 'editor',
    defaultBinding: bare('d'),
  },
  ipynb_render: {
    id: 'ipynb_render',
    labelKey: 'shortcuts.nb_render',
    scope: 'editor',
    defaultBinding: kb('k', { shift: true }),
  },
}

/** Display order for the shortcut groups in the settings dialog */
export interface ShortcutGroup {
  titleKey: string
  actions: ShortcutActionId[]
  presetGroup?: 'rmd' | 'ipynb'
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    titleKey: 'shortcuts.general',
    actions: ['toggle_sidebar', 'toggle_terminal', 'new_file', 'clear_terminal'],
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
    titleKey: 'shortcuts.notebook_rmd',
    actions: [
      'rmd_run_chunk',
      'rmd_run_chunk_stay',
      'rmd_run_chunk_insert',
      'rmd_run_all',
      'rmd_run_above',
      'rmd_insert_chunk',
      'rmd_insert_chunk_above',
      'rmd_insert_chunk_below',
      'rmd_delete_chunk',
      'rmd_render',
    ],
    presetGroup: 'rmd',
  },
  {
    titleKey: 'shortcuts.notebook_ipynb',
    actions: [
      'ipynb_run_chunk',
      'ipynb_run_chunk_stay',
      'ipynb_run_chunk_insert',
      'ipynb_run_all',
      'ipynb_run_above',
      'ipynb_insert_chunk',
      'ipynb_insert_chunk_above',
      'ipynb_insert_chunk_below',
      'ipynb_delete_chunk',
      'ipynb_render',
    ],
    presetGroup: 'ipynb',
  },
]

// ---------------------------------------------------------------------------
// Notebook shortcut presets
// ---------------------------------------------------------------------------

export type NotebookPresetId = 'rstudio' | 'jupyter'

export interface NotebookPreset {
  id: NotebookPresetId
  labelKey: string
  /** Bindings keyed by the suffix after 'rmd_' or 'ipynb_' */
  bindings: Record<string, KeyCombo>
}

export const NOTEBOOK_PRESETS: NotebookPreset[] = [
  {
    id: 'rstudio',
    labelKey: 'shortcuts.preset_rstudio',
    bindings: {
      run_chunk: kb('Enter', { shift: true }),
      run_chunk_stay: NONE,
      run_chunk_insert: NONE,
      run_all: kb('r', { alt: true }),
      run_above: kb('p', { alt: true }),
      insert_chunk: kb('i', { alt: true }),
      insert_chunk_above: NONE,
      insert_chunk_below: NONE,
      delete_chunk: NONE,
      render: kb('k', { shift: true }),
    },
  },
  {
    id: 'jupyter',
    labelKey: 'shortcuts.preset_jupyter',
    bindings: {
      run_chunk: bare('Enter', { shift: true }),
      run_chunk_stay: kb('Enter'),
      run_chunk_insert: bare('Enter', { alt: true }),
      run_all: kb('F9'),
      run_above: bare('F8'),
      insert_chunk: NONE,
      insert_chunk_above: bare('a'),
      insert_chunk_below: bare('b'),
      delete_chunk: bare('d'),
      render: kb('k', { shift: true }),
    },
  },
]

/** Suffixes of notebook action IDs (shared between rmd_ and ipynb_ prefixes) */
export const NOTEBOOK_ACTION_SUFFIXES = [
  'run_chunk',
  'run_chunk_stay',
  'run_chunk_insert',
  'run_all',
  'run_above',
  'insert_chunk',
  'insert_chunk_above',
  'insert_chunk_below',
  'delete_chunk',
  'render',
] as const

/** Build the full action IDs for a given notebook prefix */
export function notebookActionIds(prefix: 'rmd' | 'ipynb'): ShortcutActionId[] {
  return NOTEBOOK_ACTION_SUFFIXES.map((s) => `${prefix}_${s}` as ShortcutActionId)
}

/** Browser-reserved combos that cannot be reliably intercepted */
export const BROWSER_RESERVED: KeyCombo[] = [
  { key: 'w', ctrlOrMeta: true, shift: false, alt: false },
  { key: 't', ctrlOrMeta: true, shift: false, alt: false },
  { key: 'q', ctrlOrMeta: true, shift: false, alt: false },
  { key: 'l', ctrlOrMeta: true, shift: false, alt: false },
]
