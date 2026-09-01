import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { resolveByIdPrefix } from '@/lib/short-id'
import { useCohortStore } from '@/stores/cohort-store'
import { useProjectSource } from '@/stores/data-source-store'
import * as engine from '@/lib/duckdb/engine'
import {
  Play,
  Loader2,
  Code2,
  List,
  Upload,
  Download,
  Database,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CustomSqlDot } from '@/components/ui/custom-sql-dot'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CriteriaPanel } from './builder/CriteriaPanel'
import { SqlPreviewPanel } from './sql/SqlPreviewPanel'
import { ResultsPanel } from './results/ResultsPanel'
import { ImportAtlasDialog } from './atlas/ImportAtlasDialog'
import { ExportAtlasDialog } from './atlas/ExportAtlasDialog'
import { formatDateTime } from '@/lib/format-helpers'
import { localized } from '@/lib/localized'
import type { CohortLevel, CriteriaGroupNode } from '@/types'

const levelOptions: { value: CohortLevel; labelKey: string }[] = [
  { value: 'patient', labelKey: 'cohorts.level_patient' },
  { value: 'visit', labelKey: 'cohorts.level_visit' },
  { value: 'visit_detail', labelKey: 'cohorts.level_visit_detail' },
  { value: 'event', labelKey: 'cohorts.level_event' },
]

export function CohortBuilderPage() {
  const { t } = useTranslation()
  const { projectUid: uid, raw } = useResolvedParams()
  const { can } = useMyProjectRole(uid)
  const {
    cohorts,
    updateCohort,
    setCustomSql,
    executeCohort,
    materializeCohort,
    executionResults,
    executionLoading,
    executionErrors,
  } = useCohortStore()

  const cohort = resolveByIdPrefix(cohorts, raw.cohortId, (c) => c.id)
  const cohortId = cohort?.id
  const activeSource = useProjectSource(uid, cohort?.dataSourceId)
  const mapping = activeSource?.schemaMapping

  const [leftView, setLeftView] = useState<'criteria' | 'sql'>('criteria')
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [overwriteSqlDialogOpen, setOverwriteSqlDialogOpen] = useState(false)
  const [rematerializeDialogOpen, setRematerializeDialogOpen] = useState(false)
  const pendingTreeRef = useRef<CriteriaGroupNode | null>(null)

  const result = cohortId ? executionResults.get(cohortId) ?? null : null
  const loading = cohortId ? executionLoading.get(cohortId) ?? false : false
  const executionError = cohortId ? executionErrors.get(cohortId) ?? null : null

  const eventTableLabels = useMemo(
    () => Object.keys(mapping?.eventTables ?? {}),
    [mapping],
  )

  // Load min/max visit dates for period criteria defaults
  const [visitDateRange, setVisitDateRange] = useState<{ minDate: string; maxDate: string } | undefined>()
  useEffect(() => {
    if (!activeSource || !mapping?.visitTable) return
    const vt = mapping.visitTable
    if (!vt.startDateColumn) return
    const sql = `SELECT MIN("${vt.startDateColumn}")::DATE::TEXT AS min_date, MAX("${vt.startDateColumn}")::DATE::TEXT AS max_date FROM "${vt.table}"`
    engine.queryDataSource(activeSource.id, sql).then((rows) => {
      if (rows[0]?.min_date && rows[0]?.max_date) {
        setVisitDateRange({
          minDate: String(rows[0].min_date),
          maxDate: String(rows[0].max_date),
        })
      }
    }).catch(() => {})
  }, [activeSource, mapping?.visitTable])


  const handleUpdateTree = useCallback(
    (tree: CriteriaGroupNode) => {
      if (!cohortId) return
      // If there's a custom SQL, confirm overwriting it
      const currentCohort = cohorts.find((c) => c.id === cohortId)
      if (currentCohort?.customSql) {
        pendingTreeRef.current = tree
        setOverwriteSqlDialogOpen(true)
        return
      }
      updateCohort(cohortId, { criteriaTree: tree })
    },
    [cohortId, cohorts, updateCohort],
  )

  const handleConfirmOverwriteSql = useCallback(() => {
    if (!cohortId || !pendingTreeRef.current) return
    setCustomSql(cohortId, null)
    updateCohort(cohortId, { criteriaTree: pendingTreeRef.current })
    pendingTreeRef.current = null
    setOverwriteSqlDialogOpen(false)
  }, [cohortId, updateCohort, setCustomSql])

  const handleLevelChange = useCallback(
    (level: CohortLevel) => {
      if (!cohortId) return
      updateCohort(cohortId, { level })
    },
    [cohortId, updateCohort],
  )

  const handleCustomSqlChange = useCallback(
    (sql: string | null) => {
      if (!cohortId) return
      setCustomSql(cohortId, sql)
    },
    [cohortId, setCustomSql],
  )

  const handleExecute = useCallback(async () => {
    if (!cohortId || !activeSource) return
    try {
      await executeCohort(cohortId, activeSource.id, activeSource.schemaMapping)
    } catch {
      // Error handled by store
    }
  }, [cohortId, activeSource, executeCohort])

  const runMaterialize = useCallback(async () => {
    if (!cohortId || !activeSource) return
    try {
      await materializeCohort(cohortId, activeSource.id, activeSource.schemaMapping)
    } catch {
      // Error handled by store
    }
  }, [cohortId, activeSource, materializeCohort])

  const handleMaterialize = () => {
    // Re-freezing replaces the existing snapshot — confirm first.
    if (cohort?.materialization) {
      setRematerializeDialogOpen(true)
      return
    }
    void runMaterialize()
  }

  const handleConfirmRematerialize = () => {
    setRematerializeDialogOpen(false)
    void runMaterialize()
  }

  const handleExportCsv = useCallback(() => {
    if (!result || result.rows.length === 0) return
    const headers = Object.keys(result.rows[0])
    const csv = [
      headers.join(','),
      ...result.rows.map((row) =>
        headers.map((h) => {
          const v = row[h]
          return v == null ? '' : String(v)
        }).join(','),
      ),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // The name is a LocalizedString — interpolating it raw wrote
    // "cohort-[object Object].csv". English, like the export filename, so the
    // download keeps one name whatever the UI language is set to.
    a.download = `cohort-${localized(cohort?.name, 'en') || cohortId}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [result, cohort, cohortId])

  const handleAtlasImport = useCallback(
    (tree: CriteriaGroupNode) => {
      if (!cohortId) return
      updateCohort(cohortId, { criteriaTree: tree })
    },
    [cohortId, updateCohort],
  )

  if (!cohort) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>{t('cohorts.not_found')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5 shrink-0">
        {/* Level selector — what one row of the result stands for. Unlabelled,
            "Hospitalization" next to a cohort name read like a filter. */}
        <span className="text-xs text-muted-foreground">{t('cohorts.level_label')}</span>
        <Select value={cohort.level} onValueChange={(v) => handleLevelChange(v as CohortLevel)}>
          <SelectTrigger className="h-7 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {levelOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* View toggles (left pane: criteria vs SQL) */}
        <div className="flex items-center rounded-md border p-0.5">
          <button
            type="button"
            onClick={() => setLeftView('criteria')}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
              leftView === 'criteria'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <List size={12} />
            {t('cohorts.view_criteria')}
          </button>
          <button
            type="button"
            onClick={() => setLeftView('sql')}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
              leftView === 'sql'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Code2 size={12} />
            SQL
            {cohort.customSql && <CustomSqlDot />}
          </button>
        </div>

        <div className="flex-1" />

        {/* Materialization freshness */}
        {cohort.materialization && (
          <span
            className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
            title={t('cohorts.materialized_tooltip', {
              count: cohort.materialization.count,
              date: formatDateTime(cohort.materialization.materializedAt),
            })}
          >
            <Database size={11} />
            {t('cohorts.materialized_at', {
              date: formatDateTime(cohort.materialization.materializedAt),
            })}
          </span>
        )}

        {/* Import/Export (export is a read operation → not gated) */}
        <Button variant="ghost" size="sm" disabled={!can('cohorts:write')} onClick={() => setImportDialogOpen(true)} className="h-6 gap-1 text-xs">
          <Upload size={12} />
          {t('common.import')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setExportDialogOpen(true)} className="h-6 gap-1 text-xs">
          <Download size={12} />
          {t('common.export')}
        </Button>

        {/* Materialize (freeze membership) */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleMaterialize}
          disabled={loading || !activeSource || cohort.level === 'event' || !can('cohorts:write')}
          className="h-6 gap-1 text-xs"
          title={cohort.level === 'event' ? t('cohorts.materialize_event_disabled') : undefined}
        >
          <Database size={12} />
          {t('cohorts.materialize')}
        </Button>

        {/* Execute */}
        <Button
          size="sm"
          onClick={handleExecute}
          disabled={loading || !activeSource || !can('cohorts:write')}
          className="h-6 gap-1 text-xs"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          {t('cohorts.execute')}
        </Button>
      </div>

      {/* Main content: split panes */}
      <div className="flex-1 min-h-0">
        <Allotment>
          <Allotment.Pane preferredSize="50%" minSize={300}>
            {leftView === 'criteria' ? (
              <div className="h-full overflow-auto">
                <CriteriaPanel
                  criteriaTree={cohort.criteriaTree}
                  onChange={handleUpdateTree}
                  eventTableLabels={eventTableLabels}
                  genderValues={mapping?.genderValues}
                  visitDateRange={visitDateRange}
                  dataSourceId={activeSource?.id}
                  schemaMapping={mapping}
                />
              </div>
            ) : (
              <SqlPreviewPanel
                cohort={cohort}
                mapping={mapping}
                onCustomSqlChange={handleCustomSqlChange}
                onExecute={handleExecute}
              />
            )}
          </Allotment.Pane>
          <Allotment.Pane preferredSize="50%" minSize={250}>
            <ResultsPanel
              result={result}
              loading={loading}
              error={executionError}
              onExecute={handleExecute}
              onExportCsv={handleExportCsv}
            />
          </Allotment.Pane>
        </Allotment>
      </div>

      {/* Import/Export dialogs */}
      <ImportAtlasDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        onImport={handleAtlasImport}
      />
      <ExportAtlasDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        cohort={cohort}
      />

      {/* Confirm overwriting custom SQL when criteria change */}
      <AlertDialog open={overwriteSqlDialogOpen} onOpenChange={(open) => {
        if (!open) pendingTreeRef.current = null
        setOverwriteSqlDialogOpen(open)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cohorts.sql_overwrite_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('cohorts.sql_overwrite_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmOverwriteSql}>
              {t('cohorts.sql_overwrite_confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm re-materializing (replaces the frozen snapshot) */}
      <AlertDialog open={rematerializeDialogOpen} onOpenChange={setRematerializeDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cohorts.rematerialize_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {cohort.materialization
                ? t('cohorts.rematerialize_description', {
                    date: formatDateTime(cohort.materialization.materializedAt),
                  })
                : t('cohorts.rematerialize_description_generic')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRematerialize}>
              {t('cohorts.rematerialize_confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
