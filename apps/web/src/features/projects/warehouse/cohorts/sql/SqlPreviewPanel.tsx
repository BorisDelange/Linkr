import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { buildCohortCountSql } from '@/lib/duckdb/cohort-query'
import type { Cohort, SchemaMapping } from '@/types'

interface SqlPreviewPanelProps {
  cohort: Cohort
  mapping: SchemaMapping | undefined
  onCustomSqlChange: (sql: string | null) => void
}

export function SqlPreviewPanel({ cohort, mapping, onCustomSqlChange }: SqlPreviewPanelProps) {
  const { t } = useTranslation()
  const [editable, setEditable] = useState(!!cohort.customSql)
  const [copied, setCopied] = useState(false)

  const autoSql = useMemo(() => {
    if (!mapping) return null
    return buildCohortCountSql(cohort, mapping)
  }, [cohort, mapping])

  const displaySql = cohort.customSql ?? autoSql ?? ''

  const handleCopy = async () => {
    await navigator.clipboard.writeText(displaySql)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleToggleEditable = (checked: boolean) => {
    setEditable(checked)
    if (!checked && cohort.customSql) {
      onCustomSqlChange(null)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <Switch
            id="sql-edit-mode"
            checked={editable}
            onCheckedChange={handleToggleEditable}
            className="scale-75"
          />
          <Label htmlFor="sql-edit-mode" className="text-xs text-muted-foreground cursor-pointer">
            {t('cohorts.sql_edit_mode')}
          </Label>
        </div>

        <div className="flex-1" />

        {cohort.customSql && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onCustomSqlChange(null)
              setEditable(false)
            }}
            className="gap-1.5 text-xs h-7"
          >
            <RotateCcw size={12} />
            {t('cohorts.sql_reset')}
          </Button>
        )}

        <Button variant="ghost" size="sm" onClick={handleCopy} className="gap-1.5 text-xs h-7">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t('common.copied') : t('cohorts.sql_copy')}
        </Button>
      </div>

      <div className="flex-1 min-h-0">
        <CodeEditor
          language="sql"
          value={displaySql}
          readOnly={!editable}
          onChange={(val) => {
            if (editable && val !== undefined) {
              onCustomSqlChange(val)
            }
          }}
        />
      </div>
    </div>
  )
}
