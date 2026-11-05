import { useEffect, useRef, type ComponentProps } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'

type SafeDiffEditorProps = Omit<ComponentProps<typeof DiffEditor>, 'keepCurrentOriginalModel' | 'keepCurrentModifiedModel'>

/**
 * `DiffEditor` that unmounts without throwing. The wrapper disposes its two text
 * models before the widget lets go of them, which Monaco reports as an uncaught
 * "TextModel got disposed before DiffEditorWidget model got reset" every time a
 * diff dialog closes. Here the wrapper keeps the models and they are disposed
 * once the widget is gone.
 */
export function SafeDiffEditor({ onMount, ...props }: SafeDiffEditorProps) {
  const models = useRef<{ dispose(): void }[]>([])

  const handleMount: DiffOnMount = (editor, monaco) => {
    const { original, modified } = editor.getModel() ?? {}
    models.current = [original, modified].filter((m): m is NonNullable<typeof m> => !!m)
    onMount?.(editor, monaco)
  }

  useEffect(() => () => {
    const owned = models.current
    // After the wrapper's own cleanup has disposed the widget.
    setTimeout(() => owned.forEach((m) => m.dispose()), 0)
  }, [])

  return <DiffEditor {...props} onMount={handleMount} keepCurrentOriginalModel keepCurrentModifiedModel />
}
