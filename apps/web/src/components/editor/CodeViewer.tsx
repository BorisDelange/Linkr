import { useCallback } from 'react'
import Editor, { type BeforeMount } from '@monaco-editor/react'
import { useAppStore, resolveEditorTheme } from '@/stores/app-store'
import { linkrDark, linkrLight } from './monaco-themes'

const languageMap: Record<string, string> = {
  r: 'r',
  python: 'python',
  sql: 'sql',
  shell: 'shell',
  json: 'json',
  markdown: 'markdown',
  plaintext: 'plaintext',
}

/**
 * Read-only, syntax-highlighted code view — the same Monaco look as the editor,
 * so a run's "source code" reads exactly as it did on the left. Unlike CodeEditor
 * it registers NO shortcuts (a viewer must never run/save) and auto-sizes to its
 * content (capped) instead of filling a pane.
 */
export function CodeViewer({ value, language }: { value: string; language: string }) {
  const { editorSettings, darkMode } = useAppStore()
  const theme = resolveEditorTheme(editorSettings.theme, darkMode)

  const lineHeight = Math.round(editorSettings.fontSize * 1.5)
  const lines = value.split('\n').length
  // Cap so a huge script doesn't take over the panel; the editor scrolls past it.
  const height = Math.min(Math.max(lines, 1) * lineHeight + 16, 400)

  const beforeMount: BeforeMount = useCallback((monaco) => {
    monaco.editor.defineTheme('linkr-dark', linkrDark)
    monaco.editor.defineTheme('linkr-light', linkrLight)
  }, [])

  return (
    <Editor
      height={height}
      language={languageMap[language] ?? language}
      value={value}
      beforeMount={beforeMount}
      theme={theme}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        fontSize: editorSettings.fontSize,
        fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
        lineNumbers: editorSettings.lineNumbers,
        tabSize: editorSettings.tabSize,
        wordWrap: editorSettings.wordWrap,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        // A viewer inside a card: quieter chrome, no active-line highlight/cursor.
        renderLineHighlight: 'none',
        overviewRulerLanes: 0,
        scrollbar: { vertical: 'auto', horizontal: 'auto' },
        padding: { top: 6, bottom: 6 },
        contextmenu: false,
      }}
    />
  )
}
