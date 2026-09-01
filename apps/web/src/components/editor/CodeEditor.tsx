import { useRef, useState, useCallback, useEffect } from 'react'
import Editor, { type OnMount, type BeforeMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useAppStore, resolveEditorTheme } from '@/stores/app-store'
import { useShortcutStore } from '@/stores/shortcut-store'
import type { KeyCombo } from '@/types/shortcuts'
import { defineLinkrThemes } from './monaco-themes'

/**
 * Control over a CodeEditor's not-yet-committed keystrokes.
 *
 * Typing is debounced (see CodeEditor), so anything that reads the file's content
 * FROM THE STORE — saving, running, exporting — must `flush()` first, or it works
 * from the text as it was up to 400ms ago. `discard()` is for the opposite case:
 * reverting, where the editor's unmount flush would otherwise write the discarded
 * keystrokes back and re-dirty the file.
 *
 * Both are no-ops when nothing is pending or no editor is mounted.
 */
export interface PendingEdits {
  flush: () => void
  discard: () => void
}

interface CodeEditorProps {
  value: string
  language: string
  onChange?: (value: string | undefined) => void
  readOnly?: boolean
  height?: string
  editorRef?: React.MutableRefObject<Monaco.editor.IStandaloneCodeEditor | null>
  /** Filled with this editor's flush/discard controls, for callers outside Monaco's
   *  own command list (the toolbar's Save and Run buttons). */
  pendingEditsRef?: React.MutableRefObject<PendingEdits | null>
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
  pendingEditsRef,
  onSave,
  onRunSelectionOrLine,
  onRunFile,
  onRunFileAsJob,
}: CodeEditorProps) {
  const internalRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const { editorSettings, darkMode } = useAppStore()

  // Typing must not go through React. `onChange` writes to the file store, which
  // rebuilds the file array, the project tree and re-renders the IDE page — per
  // keystroke, with `value` then fed back in for Monaco to reconcile. Monaco owns
  // the live text; the store only needs it to know the file is dirty and to save.
  //
  // So the store write is debounced, and while an edit is pending the editor is fed
  // its OWN text (`editorValue`). That matters: @monaco-editor/react reconciles with
  // `value !== model.getValue()` and executeEdits on a mismatch, so feeding it the
  // stale store value would edit the keystroke straight back out. An external change
  // — reverting, pulling, switching files — still flows in, arriving when nothing is
  // pending.
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Kept in a ref, assigned in an effect (never during render), so the stable flush
  // below always calls the current onChange without depending on it.
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })

  const flush = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    const text = pendingRef.current
    if (text === null) return
    pendingRef.current = null
    setPending(null)
    onChangeRef.current?.(text)
  }, [])

  const handleChange = useCallback(
    (next: string | undefined) => {
      const text = next ?? ''
      pendingRef.current = text
      setPending(text)
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      flushTimerRef.current = setTimeout(flush, 400)
    },
    [flush],
  )

  // Unmounting (closing a tab, switching files) must not drop the last edits.
  useEffect(() => flush, [flush])

  const discard = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    pendingRef.current = null
    setPending(null)
  }, [])

  // The toolbar's Save/Run buttons live in the page, not in Monaco's command list,
  // so they cannot go through the commands registered on mount. Publish the controls
  // on a ref the page owns instead. Both callbacks are stable (empty deps), so this
  // runs once per mount.
  useEffect(() => {
    if (!pendingEditsRef) return
    pendingEditsRef.current = { flush, discard }
    return () => { pendingEditsRef.current = null }
  }, [pendingEditsRef, flush, discard])

  const editorValue = pending ?? value

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

      // Every one of these reads the file's content FROM THE STORE, so the pending
      // keystrokes have to land first — otherwise saving or running right after
      // typing uses the text as it was up to 400ms ago.
      editor.addCommand(
        toMonacoKeybinding(monaco, shortcuts.save_file.binding),
        () => { flush(); onSaveRef.current?.() }
      )

      editor.addCommand(
        toMonacoKeybinding(monaco, shortcuts.run_selection_or_line.binding),
        () => { flush(); onRunSelectionOrLineRef.current?.() }
      )

      editor.addCommand(
        toMonacoKeybinding(monaco, shortcuts.run_file.binding),
        () => { flush(); onRunFileRef.current?.() }
      )

      editor.addCommand(
        toMonacoKeybinding(monaco, shortcuts.run_file_as_job.binding),
        () => { flush(); onRunFileAsJobRef.current?.() }
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
    [externalRef, flush]
  )

  return (
    <Editor
      height={height}
      language={languageMap[language] ?? language}
      value={editorValue}
      onChange={handleChange}
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
