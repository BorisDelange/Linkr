import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { buildCohortCountSql } from '@/lib/duckdb/cohort-query'
import type { Cohort, SchemaMapping } from '@/types'

interface SqlPreviewPanelProps {
  cohort: Cohort
  mapping: SchemaMapping | undefined
  onCustomSqlChange: (sql: string | null) => void
  onExecute: () => void
}

export function SqlPreviewPanel({ cohort, mapping, onCustomSqlChange, onExecute }: SqlPreviewPanelProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  // Auto-generated SQL from criteria tree
  const autoSql = useMemo(() => {
    if (!mapping) return null
    return buildCohortCountSql(cohort, mapping)
  }, [cohort, mapping])

  // The SQL currently displayed in the editor (local draft)
  // Initialize from customSql if it exists, otherwise from autoSql
  const [editorValue, setEditorValue] = useState(cohort.customSql ?? autoSql ?? '')

  // Track whether the editor has unsaved changes vs what's persisted
  const savedSql = cohort.customSql
  const hasUnsavedChanges = editorValue !== (savedSql ?? autoSql ?? '')

  // Is the persisted SQL different from auto-generated? (= "Modified" badge)
  const isModified = savedSql != null

  // Sync editor value when autoSql changes (criteria changed) and no customSql
  const prevAutoSqlRef = useRef(autoSql)
  useEffect(() => {
    if (prevAutoSqlRef.current !== autoSql && !cohort.customSql) {
      setEditorValue(autoSql ?? '')
    }
    prevAutoSqlRef.current = autoSql
  }, [autoSql, cohort.customSql])

  // Sync editor value when customSql is reset externally (e.g., reset button)
  const prevCustomSqlRef = useRef(cohort.customSql)
  useEffect(() => {
    if (prevCustomSqlRef.current !== cohort.customSql) {
      if (cohort.customSql === null || cohort.customSql === undefined) {
        // customSql was cleared → show autoSql
        setEditorValue(autoSql ?? '')
      } else {
        setEditorValue(cohort.customSql)
      }
    }
    prevCustomSqlRef.current = cohort.customSql
  }, [cohort.customSql, autoSql])

  const handleSave = useCallback(() => {
    // If editor matches autoSql, clear customSql (back to auto)
    if (editorValue === (autoSql ?? '')) {
      onCustomSqlChange(null)
    } else {
      onCustomSqlChange(editorValue)
    }
  }, [editorValue, autoSql, onCustomSqlChange])

  const handleReset = useCallback(() => {
    onCustomSqlChange(null)
    setEditorValue(autoSql ?? '')
  }, [autoSql, onCustomSqlChange])

  const handleCopy = async () => {
    await navigator.clipboard.writeText(editorValue)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        {/* Modified badge */}
        {isModified && (
          <Badge variant="outline" className="h-4 px-1.5 text-[9px] text-amber-600 border-amber-400/50 dark:text-amber-400">
            {t('cohorts.sql_modified')}
          </Badge>
        )}

        {/* Unsaved dot */}
        {hasUnsavedChanges && (
          <span
            className="size-2 rounded-full bg-orange-400 shrink-0"
            title={t('cohorts.sql_unsaved')}
          />
        )}

        <div className="flex-1" />

        {/* Reset button (only when customSql is set) */}
        {isModified && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            className="gap-1.5 text-xs h-7"
          >
            <RotateCcw size={12} />
            {t('cohorts.sql_reset')}
          </Button>
        )}

        {/* Copy button */}
        <Button variant="ghost" size="sm" onClick={handleCopy} className="gap-1.5 text-xs h-7">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t('common.copied') : t('cohorts.sql_copy')}
        </Button>
      </div>

      <div className="flex-1 min-h-0">
        <CodeEditor
          language="sql"
          value={editorValue}
          onChange={(val) => {
            if (val !== undefined) setEditorValue(val)
          }}
          onSave={handleSave}
          onRunSelectionOrLine={onExecute}
          onRunFile={onExecute}
        />
      </div>
    </div>
  )
}
