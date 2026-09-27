import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import type * as Monaco from 'monaco-editor'
import { useTranslation } from 'react-i18next'
import { Copy, Check, RotateCcw, Save, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CodeEditor } from '@/components/editor/CodeEditor'

interface GeneratedSqlEditorProps {
  /** SQL the app generates from a form; what the editor shows until edited. */
  generatedSql: string | null
  /** The hand-edited SQL, or null when the generated SQL is in effect. */
  customSql: string | null | undefined
  /** Saving text identical to the generated SQL stores null (back to generated). */
  onCustomSqlChange: (sql: string | null) => void
  /** Runs what the editor holds, saved or not: null when that is the generated
   *  SQL (the form is in effect), else the text. */
  onRun?: (sql: string | null) => void
  /** The unsaved text, as `onRun` would run it — undefined when there is none —
   *  so a Run button outside the editor runs the draft too. */
  onDraftChange?: (sql: string | null | undefined) => void
  readOnly?: boolean
  /** Toolbar content at its start, before the Modified badge. */
  toolbarStart?: ReactNode
  /** Extra toolbar content, before the Reset / Copy buttons. */
  toolbarExtra?: ReactNode
}

/**
 * The "generated, then editable" SQL editor (Cohort pattern): shows the SQL a
 * form generates, lets the user edit it, and saves the edit (Cmd+S) as
 * `customSql` — marked Modified, with a Reset back to the generated SQL.
 * Save and Cancel (back to the last saved text) sit in the toolbar too.
 *
 * Used by the cohort SQL tab and by schema-mapping relations; the overwrite
 * prompt when the form changes under an edit belongs to the caller, which knows
 * whether its generated SQL actually changed.
 */
export function GeneratedSqlEditor({
  generatedSql,
  customSql,
  onCustomSqlChange,
  onRun,
  onDraftChange,
  readOnly,
  toolbarStart,
  toolbarExtra,
}: GeneratedSqlEditorProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [editorValue, setEditorValue] = useState(customSql ?? generatedSql ?? '')
  // CodeEditor hands typing over after a debounce, so `editorValue` can trail the
  // keystrokes by a moment: Run, Save and Copy read Monaco's own text.
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const liveText = useCallback(() => editorRef.current?.getValue() ?? editorValue, [editorValue])

  const hasUnsavedChanges = editorValue !== (customSql ?? generatedSql ?? '')
  const isModified = customSql != null

  // Follow an edit set or cleared from outside (a Reset, a reload), and the
  // generated SQL while nothing is hand-edited. Adjusted during render rather
  // than in an effect, so the editor never paints the stale text first.
  const [seen, setSeen] = useState({ generatedSql, customSql })
  if (seen.customSql !== customSql) {
    setSeen({ generatedSql, customSql })
    setEditorValue(customSql ?? generatedSql ?? '')
  } else if (seen.generatedSql !== generatedSql) {
    setSeen({ generatedSql, customSql })
    if (customSql == null) setEditorValue(generatedSql ?? '')
  }

  const inEffect = useCallback(
    (text: string) => (text === (generatedSql ?? '') ? null : text),
    [generatedSql],
  )
  const handleRun = useCallback(() => onRun?.(inEffect(liveText())), [onRun, inEffect, liveText])

  useEffect(() => {
    onDraftChange?.(hasUnsavedChanges ? inEffect(editorValue) : undefined)
  }, [onDraftChange, hasUnsavedChanges, inEffect, editorValue])
  useEffect(() => () => onDraftChange?.(undefined), [onDraftChange])

  const handleSave = useCallback(() => {
    const text = liveText()
    setEditorValue(text)
    onCustomSqlChange(text === (generatedSql ?? '') ? null : text)
  }, [liveText, generatedSql, onCustomSqlChange])

  // Back to the last saved text, unlike Reset, which goes back to the generated SQL.
  const handleCancel = useCallback(() => {
    setEditorValue(customSql ?? generatedSql ?? '')
  }, [customSql, generatedSql])

  const handleReset = useCallback(() => {
    onCustomSqlChange(null)
    setEditorValue(generatedSql ?? '')
  }, [generatedSql, onCustomSqlChange])

  const handleCopy = async () => {
    await navigator.clipboard.writeText(liveText())
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        {toolbarStart}
        {isModified && (
          <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-amber-600 border-amber-400/50 dark:text-amber-400">
            {t('cohorts.sql_modified')}
          </Badge>
        )}
        {hasUnsavedChanges && (
          <span className="size-2 rounded-full bg-orange-400 shrink-0" title={t('cohorts.sql_unsaved')} />
        )}
        <div className="flex-1" />
        {toolbarExtra}
        {!readOnly && (
          <>
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={!hasUnsavedChanges} className="h-6 gap-1 text-xs">
              <Undo2 size={12} />
              {t('common.cancel')}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleSave} disabled={!hasUnsavedChanges} className="h-6 gap-1 text-xs">
              <Save size={12} />
              {t('common.save')}
            </Button>
          </>
        )}
        {isModified && !readOnly && (
          <Button variant="ghost" size="sm" onClick={handleReset} className="h-6 gap-1 text-xs">
            <RotateCcw size={12} />
            {t('cohorts.sql_reset')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={handleCopy} className="h-6 gap-1 text-xs">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t('common.copied') : t('cohorts.sql_copy')}
        </Button>
      </div>

      <div className="flex-1 min-h-0">
        <CodeEditor
          language="sql"
          value={editorValue}
          editorRef={editorRef}
          readOnly={readOnly}
          onChange={(val) => {
            if (val !== undefined) setEditorValue(val)
          }}
          onSave={readOnly ? undefined : handleSave}
          onRunSelectionOrLine={onRun ? handleRun : undefined}
          onRunFile={onRun ? handleRun : undefined}
        />
      </div>
    </div>
  )
}
