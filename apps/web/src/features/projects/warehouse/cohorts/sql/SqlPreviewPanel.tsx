import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GeneratedSqlEditor } from '@/components/editor/GeneratedSqlEditor'
import { SqlFormSelect, type SqlForm } from '@/components/editor/SqlFormSelect'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { buildCohortCriteriaSql, buildCohortNativeSql, cohortIdColumn } from '@/lib/duckdb/cohort-query'
import { labelCohortConcepts } from '../concept-labels'
import { namesRelation } from '@/lib/schema-classes/native-sql'
import { localized } from '@/lib/localized'
import type { Cohort, SchemaMapping } from '@/types'

interface SqlPreviewPanelProps {
  cohort: Cohort
  mapping: SchemaMapping | undefined
  /** The database the cohort runs on, which names its concepts. The query shown
   *  is the exact definition, never narrowed by the concept count: a hand edit
   *  starts from it, and a stale count would silently drop matches. */
  dataSourceId: string | undefined
  onCustomSqlChange: (sql: string | null) => void
  /** Runs the editor's text, saved or not (null: the criteria). */
  onExecute: (sql: string | null) => void
  onDraftChange: (sql: string | null | undefined) => void
  /** Filled with the editor's Run on its live text, for the page's Run button. */
  runRef?: React.MutableRefObject<(() => void) | null>
}

/** The form a saved query is written in: native unless it names a relation. */
const formatOf = (sql: string): SqlForm => (namesRelation(sql) ? 'linkr' : 'native')

export function SqlPreviewPanel({ cohort, mapping, dataSourceId, onCustomSqlChange, onExecute, onDraftChange, runRef }: SqlPreviewPanelProps) {
  const { t, i18n } = useTranslation()
  // The concepts' vocabulary and name, written after each id.
  const [read, setRead] = useState<{ of: Cohort; labelled: Cohort } | null>(null)
  useEffect(() => {
    if (!dataSourceId || !mapping) return
    let cancelled = false
    labelCohortConcepts(dataSourceId, mapping, cohort).catch(() => cohort)
      .then((labelled) => { if (!cancelled) setRead({ of: cohort, labelled }) })
    return () => { cancelled = true }
  }, [dataSourceId, mapping, cohort])
  // Only for the cohort it was asked about: an edited criterion waits for its own.
  const shown = (read?.of === cohort ? read.labelled : null) ?? cohort
  const linkrSql = useMemo(() => (mapping ? buildCohortCriteriaSql(shown, mapping, false) : null), [shown, mapping])
  const nativeSql = useMemo(() => (mapping ? buildCohortNativeSql(shown, mapping) : null), [shown, mapping])
  const [chosen, setChosen] = useState<SqlForm>('native')
  const [hasDraft, setHasDraft] = useState(false)

  // A saved query is shown as written: there is no way back from the database's
  // tables to Linkr's. Native is the default whenever the criteria translate.
  const saved = cohort.customSql?.trim() ? formatOf(cohort.customSql) : null
  const format: SqlForm = saved ?? (chosen === 'native' && nativeSql ? 'native' : 'linkr')
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
    <SqlFormSelect
      value={format}
      onChange={setChosen}
      disabled={!!lockedHint}
      nativeDisabled={!nativeSql && !saved}
      showHint={false}
    />
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
          runRef={runRef}
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
