import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GeneratedSqlEditor } from '@/components/editor/GeneratedSqlEditor'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { buildCohortCriteriaSql, buildCohortNativeSql, cohortIdColumn } from '@/lib/duckdb/cohort-query'
import { namesRelation } from '@/lib/schema-classes/native-sql'
import { localized } from '@/lib/localized'
import type { Cohort, SchemaMapping } from '@/types'

interface SqlPreviewPanelProps {
  cohort: Cohort
  mapping: SchemaMapping | undefined
  onCustomSqlChange: (sql: string | null) => void
  /** Runs the editor's text, saved or not (null: the criteria). */
  onExecute: (sql: string | null) => void
  onDraftChange: (sql: string | null | undefined) => void
}

/** Which tables the query is written on: the linkr_* relations, the same on
 *  every mapped database, or this database's own. */
type SqlFormat = 'native' | 'linkr'

/** The format a saved query is written in: native unless it names a relation. */
const formatOf = (sql: string): SqlFormat => (namesRelation(sql) ? 'linkr' : 'native')

export function SqlPreviewPanel({ cohort, mapping, onCustomSqlChange, onExecute, onDraftChange }: SqlPreviewPanelProps) {
  const { t, i18n } = useTranslation()
  const linkrSql = useMemo(() => (mapping ? buildCohortCriteriaSql(cohort, mapping) : null), [cohort, mapping])
  const nativeSql = useMemo(() => (mapping ? buildCohortNativeSql(cohort, mapping) : null), [cohort, mapping])
  const [chosen, setChosen] = useState<SqlFormat>('native')
  const [hasDraft, setHasDraft] = useState(false)

  // A saved query is shown as written: there is no way back from the database's
  // tables to Linkr's. Native is the default whenever the criteria translate.
  const saved = cohort.customSql?.trim() ? formatOf(cohort.customSql) : null
  const format: SqlFormat = saved ?? (chosen === 'native' && nativeSql ? 'native' : 'linkr')
  const generated = format === 'native' ? nativeSql : linkrSql

  const handleDraftChange = useCallback((sql: string | null | undefined) => {
    setHasDraft(sql !== undefined)
    onDraftChange(sql)
  }, [onDraftChange])

  const schemaName = localized(mapping?.presetLabel, i18n.language) || t('cohorts.sql_format_native_fallback')
  const lockedHint = saved
    ? t('cohorts.sql_format_locked_saved')
    : hasDraft ? t('cohorts.sql_format_locked_draft') : !nativeSql ? t('cohorts.sql_format_no_native') : undefined

  const formatSelect = (
    <Select value={format} onValueChange={(v) => setChosen(v as SqlFormat)} disabled={!!lockedHint}>
      <SelectTrigger size="sm" className="h-6 w-72 shrink-0 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="native" className="text-xs" disabled={!nativeSql && !saved}>
          {t('cohorts.sql_format_native', { schema: schemaName })}
        </SelectItem>
        <SelectItem value="linkr" className="text-xs">{t('cohorts.sql_format_linkr')}</SelectItem>
      </SelectContent>
    </Select>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-0.5 border-b px-3 py-1.5">
        <p className="text-xs text-muted-foreground">
          {cohort.level === 'event'
            ? t('cohorts.sql_contract_event')
            : t('cohorts.sql_contract', {
                column: cohortIdColumn(cohort.level),
                level: t(`cohorts.level_${cohort.level}`).toLowerCase(),
              })}
        </p>
        {format === 'native' && (
          <p className="text-[10px] text-muted-foreground/80">{t('cohorts.sql_format_native_scope', { schema: schemaName })}</p>
        )}
      </div>
      <div className="flex-1 min-h-0">
        <GeneratedSqlEditor
          generatedSql={generated}
          customSql={cohort.customSql}
          onCustomSqlChange={onCustomSqlChange}
          onRun={onExecute}
          onDraftChange={handleDraftChange}
          toolbarStart={lockedHint ? (
            // A disabled trigger receives no pointer events: the span carries the hover.
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0">{formatSelect}</span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-72 text-xs">{lockedHint}</TooltipContent>
            </Tooltip>
          ) : formatSelect}
        />
      </div>
    </div>
  )
}
