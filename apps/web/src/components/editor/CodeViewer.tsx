import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react'
import { useAppStore, resolveEditorTheme } from '@/stores/app-store'
import { defineLinkrThemes } from './monaco-themes'

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
export function CodeViewer({
  value,
  language,
  height: fixedHeight,
  maxHeight = 400,
  followEnd = false,
}: {
  value: string
  language: string
  /** Fill a container instead of auto-sizing (e.g. '100%' inside a flex modal). */
  height?: string | number
  maxHeight?: number
  /** A log: opened on its last lines, and following the new ones while the
   *  reader stays at the end — not once they scroll up to read. */
  followEnd?: boolean
}) {
  const { t } = useTranslation()
  const { editorSettings, darkMode } = useAppStore()
  const theme = resolveEditorTheme(editorSettings.theme, darkMode)

  const lineHeight = Math.round(editorSettings.fontSize * 1.5)
  const lines = value.split('\n').length
  // Cap so a huge script doesn't take over the panel; the editor scrolls past it.
  const height = fixedHeight ?? Math.min(Math.max(lines, 1) * lineHeight + 16, maxHeight)

  const beforeMount: BeforeMount = useCallback((monaco) => {
    defineLinkrThemes(monaco)
  }, [])

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const atEnd = useRef(true)
  const toEnd = useCallback(() => {
    const editor = editorRef.current
    const lines = editor?.getModel()?.getLineCount()
    if (editor && lines) editor.revealLine(lines)
  }, [])
  const onMount: OnMount = useCallback((editor) => {
    editorRef.current = editor
    if (!followEnd) return
    toEnd()
    editor.onDidScrollChange((e) => {
      atEnd.current = e.scrollTop + editor.getLayoutInfo().height >= e.scrollHeight - lineHeight
    })
  }, [followEnd, toEnd, lineHeight])
  useEffect(() => {
    if (followEnd && atEnd.current) toEnd()
  }, [value, followEnd, toEnd])

  return (
    <Editor
      height={height}
      language={languageMap[language] ?? language}
      value={value}
      beforeMount={beforeMount}
      onMount={onMount}
      theme={theme}
      // Default placeholder is an unstyled div inheriting the parent font size.
      loading={<span className="text-xs text-muted-foreground">{t('app.loading')}</span>}
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
