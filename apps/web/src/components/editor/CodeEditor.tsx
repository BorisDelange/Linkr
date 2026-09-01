import { useRef, useCallback, useEffect } from 'react'
import Editor, { type OnMount, type BeforeMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useAppStore, resolveEditorTheme } from '@/stores/app-store'
import { useShortcutStore } from '@/stores/shortcut-store'
import type { KeyCombo } from '@/types/shortcuts'
import { defineLinkrThemes } from './monaco-themes'

interface CodeEditorProps {
  value: string
  language: string
  onChange?: (value: string | undefined) => void
  readOnly?: boolean
  height?: string
  editorRef?: React.MutableRefObject<Monaco.editor.IStandaloneCodeEditor | null>
  onSave?: () => void
  onRunSelectionOrLine?: () => void
  onRunFile?: () => void
  onRunFileAsJob?: () => void
}

const languageMap: Record<string, string> = {
  r: 'r',
  python: 'python',
  sql: 'sql',
  shell: 'shell',
  json: 'json',
  markdown: 'markdown',
  plaintext: 'plaintext',
}

function keyStringToMonacoCode(
  monaco: typeof Monaco,
  key: string
): number {
  const k = key.toLowerCase()
  if (k === 'enter') return monaco.KeyCode.Enter
  if (k === 'escape') return monaco.KeyCode.Escape
  if (k === 'backspace') return monaco.KeyCode.Backspace
  if (k === 'tab') return monaco.KeyCode.Tab
  if (k === 'space') return monaco.KeyCode.Space
  if (k === '`') return monaco.KeyCode.Backquote
  if (k === '-') return monaco.KeyCode.Minus
  if (k === '=') return monaco.KeyCode.Equal
  if (k === '[') return monaco.KeyCode.BracketLeft
  if (k === ']') return monaco.KeyCode.BracketRight
  if (k === '\\') return monaco.KeyCode.Backslash
  if (k === ';') return monaco.KeyCode.Semicolon
  if (k === "'") return monaco.KeyCode.Quote
  if (k === ',') return monaco.KeyCode.Comma
  if (k === '.') return monaco.KeyCode.Period
  if (k === '/') return monaco.KeyCode.Slash

  // Single letter a-z
  if (k.length === 1 && k >= 'a' && k <= 'z') {
    const code = `Key${k.toUpperCase()}` as keyof typeof monaco.KeyCode
    return (monaco.KeyCode[code] as number) ?? monaco.KeyCode.Unknown
  }

  // Digit 0-9
  if (k.length === 1 && k >= '0' && k <= '9') {
    const code = `Digit${k}` as keyof typeof monaco.KeyCode
    return (monaco.KeyCode[code] as number) ?? monaco.KeyCode.Unknown
  }

  return monaco.KeyCode.Unknown
}

function toMonacoKeybinding(
  monaco: typeof Monaco,
  combo: KeyCombo
): number {
  let binding = 0
  if (combo.ctrlOrMeta) binding |= monaco.KeyMod.CtrlCmd
  if (combo.shift) binding |= monaco.KeyMod.Shift
  if (combo.alt) binding |= monaco.KeyMod.Alt
  binding |= keyStringToMonacoCode(monaco, combo.key)
  return binding
}

export function CodeEditor({
  value,
  language,
  onChange,
  readOnly = false,
  height = '100%',
  editorRef: externalRef,
  onSave,
  onRunSelectionOrLine,
  onRunFile,
  onRunFileAsJob,
}: CodeEditorProps) {
  const internalRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const { editorSettings, darkMode } = useAppStore()

  // Store latest callbacks in refs so Monaco addCommand always calls current version
  const onSaveRef = useRef(onSave)
  const onRunSelectionOrLineRef = useRef(onRunSelectionOrLine)
  const onRunFileRef = useRef(onRunFile)
  const onRunFileAsJobRef = useRef(onRunFileAsJob)
  useEffect(() => {
    onSaveRef.current = onSave
    onRunSelectionOrLineRef.current = onRunSelectionOrLine
    onRunFileRef.current = onRunFile
    onRunFileAsJobRef.current = onRunFileAsJob
  })

  const resolvedTheme = resolveEditorTheme(editorSettings.theme, darkMode)

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    defineLinkrThemes(monaco)
  }, [])

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      internalRef.current = editor
      if (externalRef) {
        externalRef.current = editor
      }

      // Register editor-scoped shortcuts from the store
      const shortcuts = useShortcutStore.getState().shortcuts

      editor.addCommand(
        toMonacoKeybinding(monaco, shortcuts.save_file.binding),
        () => onSaveRef.current?.()
      )

      editor.addCommand(
        toMonacoKeybinding(monaco, shortcuts.run_selection_or_line.binding),
        () => onRunSelectionOrLineRef.current?.()
      )

      editor.addCommand(
        toMonacoKeybinding(monaco, shortcuts.run_file.binding),
        () => onRunFileRef.current?.()
      )

      editor.addCommand(
        toMonacoKeybinding(monaco, shortcuts.run_file_as_job.binding),
        () => onRunFileAsJobRef.current?.()
      )

      // Toggle comment (Cmd+Shift+C by default) — triggers Monaco's built-in comment action
      editor.addCommand(
        toMonacoKeybinding(monaco, shortcuts.toggle_comment.binding),
        () => editor.getAction('editor.action.commentLine')?.run()
      )

      // Clear terminal / output (Cmd+K) — dispatch a global keydown so the
      // FilesPage global-shortcut handler fires. matchesCombo compares
      // event.code (e.g. 'KeyK') for letters, so the synthetic event MUST set
      // `code` too — a bare `key` alone never matches.
      editor.addCommand(
        toMonacoKeybinding(monaco, shortcuts.clear_terminal.binding),
        () => {
          const k = shortcuts.clear_terminal.binding.key
          const code = /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k
          window.dispatchEvent(new KeyboardEvent('keydown', {
            key: k,
            code,
            metaKey: shortcuts.clear_terminal.binding.ctrlOrMeta,
            ctrlKey: shortcuts.clear_terminal.binding.ctrlOrMeta,
            shiftKey: shortcuts.clear_terminal.binding.shift,
            altKey: shortcuts.clear_terminal.binding.alt,
            bubbles: true,
          }))
        }
      )
    },
    [externalRef]
  )

  return (
    <Editor
      height={height}
      language={languageMap[language] ?? language}
      value={value}
      onChange={onChange}
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      theme={resolvedTheme}
      options={{
        readOnly,
        domReadOnly: readOnly,
        minimap: { enabled: editorSettings.minimap },
        fontSize: editorSettings.fontSize,
        fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
        lineNumbers: editorSettings.lineNumbers,
        tabSize: editorSettings.tabSize,
        wordWrap: editorSettings.wordWrap,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 8 },
      }}
    />
  )
}
