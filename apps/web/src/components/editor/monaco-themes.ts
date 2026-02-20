/**
 * Custom Monaco Editor themes that match the Linkr UI color palette.
 *
 * Dark theme: blue-tinted dark colors from the app's .dark CSS variables
 * Light theme: cool-tinted light colors from the app's :root CSS variables
 */
import type * as Monaco from 'monaco-editor'

type IStandaloneThemeData = Monaco.editor.IStandaloneThemeData

/**
 * linkr-dark — blue-tinted dark theme matching the app's dark mode palette.
 *
 * Key colors (from index.css .dark):
 *   background  #020618   card/sidebar  #0f172b
 *   muted       #1d293d   muted-fg      #90a1b9
 *   foreground  #f8fafc   ring          #6a7282
 *   primary     #e2e8f0   accent-blue   #1447e6
 */
export const linkrDark: IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // --- general tokens ---
    { token: '', foreground: 'e2e8f0' },
    { token: 'comment', foreground: '6a7282', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c4b5fd' },           // violet-300
    { token: 'keyword.control', foreground: 'c4b5fd' },
    { token: 'storage', foreground: 'c4b5fd' },
    { token: 'string', foreground: '86efac' },             // green-300
    { token: 'string.escape', foreground: '6ee7b7' },
    { token: 'number', foreground: 'fcd34d' },             // amber-300
    { token: 'constant', foreground: 'fcd34d' },
    { token: 'type', foreground: '7dd3fc' },               // sky-300
    { token: 'type.identifier', foreground: '7dd3fc' },
    { token: 'class', foreground: '7dd3fc' },
    { token: 'function', foreground: '93c5fd' },           // blue-300
    { token: 'function.declaration', foreground: '93c5fd' },
    { token: 'variable', foreground: 'e2e8f0' },
    { token: 'variable.predefined', foreground: 'f9a8d4' },// pink-300
    { token: 'operator', foreground: '94a3b8' },           // slate-400
    { token: 'delimiter', foreground: '94a3b8' },
    { token: 'tag', foreground: '7dd3fc' },
    { token: 'attribute.name', foreground: 'c4b5fd' },
    { token: 'attribute.value', foreground: '86efac' },
    { token: 'metatag', foreground: '94a3b8' },
    // --- R-specific ---
    { token: 'predefined.r', foreground: '93c5fd' },
    // --- SQL ---
    { token: 'predefined.sql', foreground: 'c4b5fd' },
    // --- JSON ---
    { token: 'string.key.json', foreground: '93c5fd' },
    { token: 'string.value.json', foreground: '86efac' },
  ],
  colors: {
    'editor.background': '#0f172b',
    'editor.foreground': '#e2e8f0',
    'editor.lineHighlightBackground': '#1d293d',
    'editor.selectionBackground': '#1e40af55',
    'editor.inactiveSelectionBackground': '#1e3a5f44',
    'editorCursor.foreground': '#93c5fd',
    'editorLineNumber.foreground': '#475569',
    'editorLineNumber.activeForeground': '#94a3b8',
    'editorIndentGuide.background': '#1e293b',
    'editorIndentGuide.activeBackground': '#334155',
    'editorWidget.background': '#0f172b',
    'editorWidget.border': '#1d293d',
    'editorSuggestWidget.background': '#0f172b',
    'editorSuggestWidget.border': '#1d293d',
    'editorSuggestWidget.selectedBackground': '#1d293d',
    'editorHoverWidget.background': '#0f172b',
    'editorHoverWidget.border': '#1d293d',
    'editorGutter.background': '#0b1120',
    'editorBracketMatch.background': '#1e40af33',
    'editorBracketMatch.border': '#1e40af88',
    'editor.findMatchBackground': '#1e40af55',
    'editor.findMatchHighlightBackground': '#1e40af33',
    'editorOverviewRuler.border': '#1d293d',
    'scrollbarSlider.background': '#1d293d88',
    'scrollbarSlider.hoverBackground': '#334155aa',
    'scrollbarSlider.activeBackground': '#475569cc',
    'minimap.background': '#0b1120',
  },
}

/**
 * linkr-light — cool-tinted light theme matching the app's light mode palette.
 *
 * Key colors (from index.css :root):
 *   background  #ffffff   muted     #f1f5f9
 *   muted-fg    #62748e   border    #e2e8f0
 *   foreground  #020618   primary   #0f172b
 */
export const linkrLight: IStandaloneThemeData = {
  base: 'vs',
  inherit: true,
  rules: [
    { token: '', foreground: '0f172b' },
    { token: 'comment', foreground: '62748e', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7c3aed' },           // violet-600
    { token: 'keyword.control', foreground: '7c3aed' },
    { token: 'storage', foreground: '7c3aed' },
    { token: 'string', foreground: '16a34a' },             // green-600
    { token: 'string.escape', foreground: '15803d' },
    { token: 'number', foreground: 'd97706' },             // amber-600
    { token: 'constant', foreground: 'd97706' },
    { token: 'type', foreground: '0284c7' },               // sky-600
    { token: 'type.identifier', foreground: '0284c7' },
    { token: 'class', foreground: '0284c7' },
    { token: 'function', foreground: '2563eb' },           // blue-600
    { token: 'function.declaration', foreground: '2563eb' },
    { token: 'variable', foreground: '0f172b' },
    { token: 'variable.predefined', foreground: 'db2777' },// pink-600
    { token: 'operator', foreground: '475569' },           // slate-600
    { token: 'delimiter', foreground: '475569' },
    { token: 'tag', foreground: '0284c7' },
    { token: 'attribute.name', foreground: '7c3aed' },
    { token: 'attribute.value', foreground: '16a34a' },
    { token: 'metatag', foreground: '475569' },
    { token: 'predefined.r', foreground: '2563eb' },
    { token: 'predefined.sql', foreground: '7c3aed' },
    { token: 'string.key.json', foreground: '2563eb' },
    { token: 'string.value.json', foreground: '16a34a' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#0f172b',
    'editor.lineHighlightBackground': '#f1f5f9',
    'editor.selectionBackground': '#bfdbfe88',
    'editor.inactiveSelectionBackground': '#bfdbfe44',
    'editorCursor.foreground': '#2563eb',
    'editorLineNumber.foreground': '#94a3b8',
    'editorLineNumber.activeForeground': '#475569',
    'editorIndentGuide.background': '#e2e8f0',
    'editorIndentGuide.activeBackground': '#cbd5e1',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#e2e8f0',
    'editorSuggestWidget.background': '#ffffff',
    'editorSuggestWidget.border': '#e2e8f0',
    'editorSuggestWidget.selectedBackground': '#f1f5f9',
    'editorHoverWidget.background': '#ffffff',
    'editorHoverWidget.border': '#e2e8f0',
    'editorGutter.background': '#f8fafc',
    'editorBracketMatch.background': '#bfdbfe55',
    'editorBracketMatch.border': '#60a5fa88',
    'editor.findMatchBackground': '#bfdbfe88',
    'editor.findMatchHighlightBackground': '#bfdbfe44',
    'editorOverviewRuler.border': '#e2e8f0',
    'scrollbarSlider.background': '#94a3b844',
    'scrollbarSlider.hoverBackground': '#94a3b866',
    'scrollbarSlider.activeBackground': '#64748b88',
    'minimap.background': '#f8fafc',
  },
}
