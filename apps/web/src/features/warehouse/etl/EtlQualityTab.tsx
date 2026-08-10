import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Building2,
  CheckCircle2,
  Database,
  Download,
  Loader2,
  RefreshCw,
  Search,
  Table2,
  Users,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  ConceptDataTable,
  TruncatedText,
  type ConceptColumn,
} from '@/components/ui/concept-data-table'
import { cn } from '@/lib/utils'
import { isServerMode } from '@/lib/api-client'
import { getStorage } from '@/lib/storage'
import * as duckdbEngine from '@/lib/duckdb/engine'
import { computeDatabaseStats } from '@/lib/duckdb/database-stats'
import { formatDateTimeLocale, validateIntegerIds } from '@/lib/format-helpers'
import { csvBlob, toCsv } from '@/lib/csv-export'
import { downloadBlob } from '@/lib/entity-io'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import {
  classifyDiff,
  CLINICAL_TABLES,
  countByDiff,
  expectedRowsByTarget,
  sortTableCounts,
  type ConceptCount,
  type QualityConceptRow,
  type QualityDiff,
  type TableSort,
  type TableSortKey,
} from './quality-diff'
import type { DatabaseStatsCache, DataSource, TableRowCount } from '@/types'

type QualityTab = 'statistics' | 'concepts'

/** Sub-tab last looked at, so leaving and coming back lands where you were. */
let lastQualityTab: QualityTab = 'statistics'

interface Props {
  pipelineId: string
}

/**
 * Did the ETL do what the mapping said it would?
 *
 * Two views on the same question: overall figures for both databases side by
 * side, and per-concept counts comparing what arrived carrying a source concept
 * against what came out mapped to a standard one.
 */
export function EtlQualityTab({ pipelineId }: Props) {
  const { t } = useTranslation()
  const { etlPipelines } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const [activeTab, setActiveTab] = useState<QualityTab>(lastQualityTab)
  const selectTab = useCallback((tab: QualityTab) => {
    lastQualityTab = tab
    setActiveTab(tab)
  }, [])
  /**
   * Right-hand controls of the tab bar, supplied by whichever view is active.
   *
   * One bar for both views rather than a second row under Concepts: the toolbar
   * was costing a row of height on a full-width table, and Statistics had its
   * action buried inside a card.
   */
  const [actions, setActions] = useState<React.ReactNode>(null)

  const pipeline = etlPipelines.find((p) => p.id === pipelineId)
  const sourceDs = dataSources.find((ds) => ds.id === pipeline?.sourceDataSourceId)
  const targetDs = dataSources.find((ds) => ds.id === pipeline?.targetDataSourceId)

  // No mapping-project picker here: a pipeline has ONE mapping project, chosen in
  // the Vocabulary tab. A second control for the same field invited the two views
  // to disagree about which dictionary the check was against.
  if (!sourceDs && !targetDs) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('etl.comparison_no_db')}</p>
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full min-w-0 flex-col">
        <div className="flex items-center gap-0.5 border-b px-3 py-1">
          {(['statistics', 'concepts'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => selectTab(tab)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                activeTab === tab
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              {t(`etl.comparison_tab_${tab}`)}
            </button>
          ))}
          <div className="ml-auto flex min-w-0 items-center gap-1.5">{actions}</div>
        </div>

        <div className="min-h-0 min-w-0 flex-1">
          {activeTab === 'statistics'
            ? <StatisticsView sourceDs={sourceDs} targetDs={targetDs} onActions={setActions} />
            : <ConceptQualityView targetDs={targetDs} onActions={setActions} />}
        </div>
      </div>
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------------------
// Statistics — both databases side by side
// ---------------------------------------------------------------------------

function StatisticsView({
  sourceDs,
  targetDs,
  onActions,
}: {
  sourceDs: DataSource | undefined
  targetDs: DataSource | undefined
  onActions: (node: React.ReactNode) => void
}) {
  const { t, i18n } = useTranslation()
  const [sourceStats, setSourceStats] = useState<DatabaseStatsCache | null>(null)
  const [targetStats, setTargetStats] = useState<DatabaseStatsCache | null>(null)
  const [loading, setLoading] = useState(false)

  /**
   * Count one database and SAVE the result.
   *
   * The counts were recomputed on every visit and thrown away, so the work was
   * repeated for figures that only change when the pipeline runs. They now go to
   * databaseStatsCache — the same store the Databases page uses, backed by the
   * server's /stats-cache in server mode.
   */
  const computeOne = async (ds: DataSource | undefined): Promise<DatabaseStatsCache | null> => {
    if (!ds?.id || !ds.schemaMapping) return null
    try {
      const fresh = await computeDatabaseStats(ds.id, ds.schemaMapping)
      // Merge, not replace: tableCounts belong to the schema browser, which fills
      // them separately — overwriting with our empty list would erase them.
      const existing = await getStorage().databaseStatsCache.get(ds.id).catch(() => undefined)
      const merged = { ...fresh, tableCounts: fresh.tableCounts.length ? fresh.tableCounts : existing?.tableCounts ?? [] }
      await getStorage().databaseStatsCache.save(merged).catch(() => {})
      return merged
    } catch {
      return null
    }
  }

  const computeStats = useCallback(async () => {
    setLoading(true)
    const [src, tgt] = await Promise.all([computeOne(sourceDs), computeOne(targetDs)])
    setSourceStats(src)
    setTargetStats(tgt)
    setLoading(false)
  // computeOne only reads the two data sources, both listed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceDs?.id, sourceDs?.schemaMapping, targetDs?.id, targetDs?.schemaMapping])

  /** Newest of the two timestamps: one button recomputes both, so one date. */
  const computedAt = [sourceStats?.computedAt, targetStats?.computedAt]
    .filter((d): d is string => !!d)
    .sort()
    .at(-1)

  const canCompute = !!(sourceDs?.schemaMapping || targetDs?.schemaMapping)

  useEffect(() => {
    onActions(
      canCompute ? (
        <>
          {/* When it was last counted, so a stale figure is recognisable as one. */}
          {computedAt && (
            <span className="truncate text-[11px] text-muted-foreground">
              {t('etl.quality_stats_computed_at', { when: formatDateTimeLocale(computedAt, i18n.language) })}
            </span>
          )}
          <Button
            size="sm"
            variant={computedAt ? 'outline' : 'default'}
            className="h-7 shrink-0 px-2.5 text-xs"
            disabled={loading}
            onClick={() => void computeStats()}
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {computedAt ? t('etl.quality_stats_reload') : t('etl.quality_stats_compute')}
          </Button>
        </>
      ) : null,
    )
    // Cleared on unmount so the other view does not inherit these buttons.
    return () => onActions(null)
  }, [onActions, canCompute, computedAt, loading, computeStats, t, i18n.language])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const load = async () => {
      // Saved counts first, whatever the mode: they are what the user computed
      // last, and showing them beats an empty card plus a fresh scan.
      const [srcCached, tgtCached] = await Promise.all([
        sourceDs?.id ? getStorage().databaseStatsCache.get(sourceDs.id).catch(() => undefined) : undefined,
        targetDs?.id ? getStorage().databaseStatsCache.get(targetDs.id).catch(() => undefined) : undefined,
      ])
      if (cancelled) return
      setSourceStats(srcCached ?? null)
      setTargetStats(tgtCached ?? null)

      // Server mode never auto-counts: COUNT(*) could run over very large tables,
      // so the user asks for it with the button.
      if (isServerMode()) {
        setLoading(false)
        return
      }
      const [src, tgt] = await Promise.all([
        srcCached ? Promise.resolve(srcCached) : computeOne(sourceDs),
        tgtCached ? Promise.resolve(tgtCached) : computeOne(targetDs),
      ])
      if (cancelled) return
      setSourceStats(src)
      setTargetStats(tgt)
      setLoading(false)
    }
    void load()
    return () => { cancelled = true }
  // computeOne only reads the two data sources, both listed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceDs?.id, sourceDs?.schemaMapping, targetDs?.id, targetDs?.schemaMapping])

  return (
    <ScrollArea className="h-full">
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
        <StatsColumn label={t('etl.source')} ds={sourceDs} stats={sourceStats} loading={loading} accent="orange" />
        <StatsColumn label={t('etl.target')} ds={targetDs} stats={targetStats} loading={loading} accent="emerald" />
      </div>
    </ScrollArea>
  )
}

function StatsColumn({
  label,
  ds,
  stats,
  loading,
  accent,
}: {
  label: string
  ds: DataSource | undefined
  stats: DatabaseStatsCache | null
  loading: boolean
  accent: 'orange' | 'emerald'
}) {
  const { t } = useTranslation()
  const borderColor = accent === 'orange' ? 'border-orange-500/30' : 'border-emerald-500/30'
  const iconColor = accent === 'orange' ? 'text-orange-500' : 'text-emerald-500'

  if (!ds) {
    return (
      <div className={cn('rounded-lg border-2 p-4 text-center', borderColor)}>
        <Database size={20} className="mx-auto text-muted-foreground/30" />
        <p className="mt-2 text-xs text-muted-foreground">{t('etl.pipeline_no_db_selected')}</p>
      </div>
    )
  }

  return (
    <div className={cn('min-w-0 space-y-3 rounded-lg border-2 p-3', borderColor)}>
      <div className="flex min-w-0 items-center gap-2">
        <Database size={14} className={cn('shrink-0', iconColor)} />
        <span className="shrink-0 text-xs font-medium">{label}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">— {ds.name}</span>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          {t('common.loading')}…
        </div>
      )}

      {/* Without this the card was a bare "Source — MIMIC-IV" and nothing else,
          which reads as a rendering fault rather than "not computed". Server mode
          never auto-counts, and a database with no data model has nothing to count. */}
      {!loading && !stats && (
        <div className="space-y-2 py-1">
          <p className="text-[11px] text-muted-foreground">
            {/* The MISSING MODEL is checked first, whatever the mode: it is the
                specific reason nothing can be counted, and it says what to do
                about it. Testing server mode first told the user the counts were
                merely not automatic, then withheld the button with no explanation
                — leaving "why is there one on target and not on source?". */}
            {!ds.schemaMapping
              ? t('etl.quality_stats_no_model')
              : isServerMode()
                ? t('etl.quality_stats_server')
                : t('etl.quality_stats_unavailable')}
          </p>
        </div>
      )}

      {stats && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <StatBox icon={<Users size={16} className="text-blue-500" />} value={stats.summary.patientCount} label={t('etl.sidebar_patients')} />
            <StatBox icon={<Activity size={16} className="text-emerald-500" />} value={stats.summary.visitCount} label={t('etl.sidebar_visits')} />
            <StatBox icon={<Building2 size={16} className="text-amber-500" />} value={stats.summary.visitDetailCount} label={t('etl.sidebar_visit_units')} />
          </div>

          {stats.tableCounts.length > 0 && <TableCountList counts={stats.tableCounts} />}
        </div>
      )}
    </div>
  )
}

/**
 * The per-table row counts, searchable and sortable.
 *
 * A full OMOP target runs to dozens of tables in export order, so finding one
 * meant reading the whole list, and "which table is biggest" was not answerable
 * at all. Sorting is local to each column (source and target are independent
 * lists, and comparing them is the Concepts view's job, not this one's).
 */
function TableCountList({ counts }: { counts: TableRowCount[] }) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<TableSort>({ by: 'rows', desc: true })

  const shown = useMemo(() => sortTableCounts(counts, search, sort), [counts, search, sort])

  const toggle = (by: TableSortKey) => {
    // Re-clicking the active column flips it; a new column starts in the
    // direction that column is usually read — A→Z for names, biggest first
    // for counts.
    setSort((s) => (s.by === by ? { by, desc: !s.desc } : { by, desc: by === 'rows' }))
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <h4 className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('etl.sidebar_tables')} ({shown.length === counts.length ? counts.length : `${shown.length}/${counts.length}`})
        </h4>
        <div className="relative ml-auto min-w-0 flex-1">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('etl.quality_stats_search_tables')}
            className="h-6 pl-6 pr-6 text-[11px]"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              title={t('common.clear')}
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-b px-1 pb-1">
        <SortHeader label={t('etl.quality_stats_table_name')} active={sort.by === 'name'} desc={sort.desc} onClick={() => toggle('name')} className="min-w-0 flex-1" />
        <SortHeader label={t('etl.quality_stats_table_rows')} active={sort.by === 'rows'} desc={sort.desc} onClick={() => toggle('rows')} className="shrink-0" />
      </div>

      {shown.length === 0 ? (
        <p className="px-1 py-2 text-[11px] text-muted-foreground">{t('etl.quality_stats_no_table_match')}</p>
      ) : (
        <div className="space-y-0.5">
          {shown.map((tc) => (
            <div key={tc.tableName} className="flex items-center gap-2 rounded px-1 py-1 text-xs">
              <Table2 size={11} className="shrink-0 text-blue-500/60" />
              <span className="min-w-0 flex-1 truncate font-mono">{tc.tableName}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{tc.rowCount.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SortHeader({
  label,
  active,
  desc,
  onClick,
  className,
}: {
  label: string
  active: boolean
  desc: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}
      className={cn(
        'flex items-center gap-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      <span className="truncate">{label}</span>
      {active && (desc ? <ArrowDown size={10} className="shrink-0" /> : <ArrowUp size={10} className="shrink-0" />)}
    </button>
  )
}

/** Sized for THIS tab, which is full width — the pipeline sidebar's 300px forced
 *  the 9px labels these started from, and they were barely legible here. */
function StatBox({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="rounded-md border p-3 text-center">
      <div className="mx-auto mb-1 flex justify-center">{icon}</div>
      <div className="text-xl font-semibold tabular-nums">{value.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Concepts — per-concept source vs target counts
// ---------------------------------------------------------------------------

/**
 * Rows already computed, per target database.
 *
 * Module-level rather than component state: switching tabs unmounts this view,
 * and re-running a dozen COUNT queries every time is both slow and a silent
 * reset of whatever the user had filtered. Refresh re-reads deliberately.
 */
const conceptRowsCache = new Map<string, QualityConceptRow[]>()


function ConceptQualityView({
  targetDs,
  onActions,
}: {
  targetDs: DataSource | undefined
  onActions: (node: React.ReactNode) => void
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  // `t` through a ref: the column array must not be rebuilt on every render (see
  // the memo below), but it must still translate with the current language.
  const tRef = useRef(t)
  tRef.current = t
  const targetId = targetDs?.id
  const [rows, setRows] = useState<QualityConceptRow[]>(
    () => (targetId ? conceptRowsCache.get(targetId) ?? [] : []),
  )
  const [loading, setLoading] = useState(false)
  const [diffFilter, setDiffFilter] = useState<QualityDiff | null>(null)

  const load = useCallback(async (force: boolean) => {
    if (!targetId) return
    if (!force && conceptRowsCache.has(targetId)) {
      setRows(conceptRowsCache.get(targetId) ?? [])
      return
    }
    setLoading(true)
    try {
      const loaded = await loadConceptQuality(targetId)
      conceptRowsCache.set(targetId, loaded)
      setRows(loaded)
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [targetId])

  useEffect(() => { void load(false) }, [load])

  const counts = useMemo(() => countByDiff(rows), [rows])
  const shown = useMemo(
    () => (diffFilter ? rows.filter((r) => r.diff === diffFilter) : rows),
    [rows, diffFilter],
  )

  /** The filtered rows, as CSV — what is on screen, not the unfiltered set. */
  const exportCsv = useCallback(() => {
    const text = toCsv(shown, [
      { header: 'status', value: (r) => r.diff },
      { header: 'source_vocabulary_id', value: (r) => r.sourceVocabularyId },
      { header: 'source_code', value: (r) => r.sourceCode },
      { header: 'source_code_description', value: (r) => r.sourceDescription },
      { header: 'source_concept_id', value: (r) => r.sourceConceptId },
      { header: 'source_patients', value: (r) => r.sourcePatients },
      { header: 'source_rows', value: (r) => r.sourceRows },
      { header: 'expected_rows', value: (r) => r.expectedRows },
      { header: 'target_concept_id', value: (r) => r.targetConceptId },
      { header: 'target_vocabulary_id', value: (r) => r.targetVocabularyId },
      { header: 'target_patients', value: (r) => r.targetPatients },
      { header: 'target_rows', value: (r) => r.targetRows },
    ])
    downloadBlob(csvBlob(text), 'quality-check-concepts.csv')
  }, [shown])

  useEffect(() => {
    onActions(
      <>
        {/* Verdict chips as filters, in the shared bar: the label says what each
            one does — a bare "1394 OK" read as a count beside the total. */}
        <span className="shrink-0 text-[11px] text-muted-foreground">{t('etl.comparison_filter_by')}</span>
        {(['missing', 'fewer', 'more', 'match'] as const).map((d) => (
          counts[d] > 0 && (
            <button
              key={d}
              onClick={() => setDiffFilter(diffFilter === d ? null : d)}
              aria-pressed={diffFilter === d}
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors',
                DIFF_CHIP[d],
                diffFilter === d && 'ring-1 ring-current',
              )}
            >
              {counts[d].toLocaleString()} {t(`etl.comparison_${d}`)}
            </button>
          )
        ))}
        {diffFilter && (
          <button
            onClick={() => setDiffFilter(null)}
            className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted/80"
          >
            {t('etl.comparison_show_all')}
          </button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          disabled={shown.length === 0}
          onClick={exportCsv}
          title={t('etl.comparison_export_csv')}
        >
          <Download size={12} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          onClick={() => void load(true)}
          title={t('common.refresh')}
        >
          <RefreshCw size={12} />
        </Button>
      </>,
    )
    // Cleared on unmount so Statistics does not inherit these controls.
    return () => onActions(null)
  }, [onActions, counts, diffFilter, shown.length, exportCsv, load, t])

  const columns = useMemo((): ConceptColumn<QualityConceptRow>[] => [
    {
      id: 'diff',
      header: tRef.current('etl.comparison_status'),
      accessor: (r) => r.diff,
      cell: (r) => <DiffBadge diff={r.diff} />,
      filter: 'select',
      selectOptionLabel: (v) => tRef.current(`etl.comparison_${v}`, { defaultValue: v }),
      size: 90,
      center: true,
    },
    { id: 'sourceVocabularyId', header: tRef.current('etl.comparison_source_vocab'), accessor: (r) => r.sourceVocabularyId, filter: 'select', size: 150 },
    { id: 'sourceCode', header: tRef.current('etl.comparison_source_code'), accessor: (r) => r.sourceCode, filter: 'text', size: 120 },
    {
      id: 'sourceDescription',
      header: tRef.current('etl.comparison_description'),
      accessor: (r) => r.sourceDescription,
      cell: (r) => <TruncatedText>{r.sourceDescription}</TruncatedText>,
      filter: 'text',
      size: 260,
    },
    { id: 'sourcePatients', header: tRef.current('etl.comparison_source_patients'), accessor: (r) => r.sourcePatients, cell: (r) => num(r.sourcePatients), filter: 'number', size: 110 },
    { id: 'sourceRows', header: tRef.current('etl.comparison_source_rows'), accessor: (r) => r.sourceRows, cell: (r) => num(r.sourceRows), filter: 'number', size: 110 },
    { id: 'targetConceptId', header: tRef.current('etl.comparison_target_id'), accessor: (r) => r.targetConceptId, filter: 'number', size: 130 },
    { id: 'targetVocabularyId', header: tRef.current('etl.comparison_target_vocab'), accessor: (r) => r.targetVocabularyId, filter: 'select', size: 130 },
    {
      id: 'expectedRows',
      header: tRef.current('etl.comparison_expected_rows'),
      accessor: (r) => r.expectedRows,
      // Emphasised when it differs from this row's own source count: that is
      // exactly the case where the verdict is not readable from sourceRows.
      cell: (r) => (
        <span className={cn('tabular-nums', r.expectedRows !== r.sourceRows && 'font-medium text-foreground')}>
          {r.expectedRows.toLocaleString()}
        </span>
      ),
      filter: 'number',
      size: 120,
    },
    { id: 'targetPatients', header: tRef.current('etl.comparison_target_patients'), accessor: (r) => r.targetPatients, cell: (r) => num(r.targetPatients), filter: 'number', size: 110 },
    { id: 'targetRows', header: tRef.current('etl.comparison_target_rows'), accessor: (r) => r.targetRows, cell: (r) => num(r.targetRows), filter: 'number', size: 110 },
    // Keyed on the LANGUAGE, not on `t`: useTranslation returns a new `t` on every
    // render, so depending on it rebuilt this array each time — invalidating the
    // table's own memos and re-sorting all 1394 rows per render. That is what made
    // clicking a column header slow. `t` is read through a ref so the array stays
    // stable while still producing current translations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [language])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        {t('common.loading')}…
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-muted-foreground">{t('etl.comparison_no_mappings')}</p>
        <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => void load(true)}>
          <RefreshCw size={12} />
          {t('common.refresh')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="min-h-0 min-w-0 flex-1">
        <ConceptDataTable
          data={shown}
          columns={columns}
          rowKey={(r) => `${r.sourceVocabularyId}|${r.sourceCode}|${r.targetConceptId}`}
          emptyMessage={t('etl.comparison_no_mappings')}
          // A dictionary runs to thousands of mappings; rendering a DOM row for
          // each is what made sorting and resizing crawl.
          pageSize={100}
          // Biggest source volumes first: those are the mappings whose gaps matter.
          initialSorting={{ columnId: 'sourceRows', desc: true }}
        />
      </div>
    </div>
  )
}

const DIFF_CHIP: Record<QualityDiff, string> = {
  missing: 'bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25',
  fewer: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25',
  more: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 hover:bg-blue-500/25',
  match: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25',
}

function num(value: number) {
  return <span className="tabular-nums">{value.toLocaleString()}</span>
}

function DiffBadge({ diff }: { diff: QualityDiff }) {
  const { t } = useTranslation()
  const icon = diff === 'missing'
    ? <AlertTriangle size={10} />
    : diff === 'match' ? <CheckCircle2 size={10} /> : null
  return (
    <span className={cn(
      'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
      DIFF_CHIP[diff],
    )}>
      {icon}
      {t(`etl.comparison_${diff}`)}
    </span>
  )
}

/**
 * Read the STCM from the target and count each concept's rows on both sides.
 *
 * Everything is queried from the TARGET: `*_source_concept_id` for what arrived,
 * `*_concept_id` for what was mapped. A source database in its own (non-OMOP)
 * shape has no comparable columns, so comparing against it is not possible here.
 */
async function loadConceptQuality(targetDsId: string): Promise<QualityConceptRow[]> {
  const stcm = await duckdbEngine.queryDataSource(targetDsId, `
    SELECT source_vocabulary_id, source_code, source_code_description,
           source_concept_id, target_concept_id, target_vocabulary_id
    FROM source_to_concept_map
    WHERE target_concept_id != 0
  `).catch(() => [])
  if (stcm.length === 0) return []

  const mappings = stcm.map((r) => ({
    sourceVocabularyId: String(r.source_vocabulary_id ?? ''),
    sourceCode: String(r.source_code ?? ''),
    sourceDescription: String(r.source_code_description ?? ''),
    sourceConceptId: Number(r.source_concept_id ?? 0),
    targetConceptId: Number(r.target_concept_id ?? 0),
    targetVocabularyId: String(r.target_vocabulary_id ?? ''),
  }))

  const sourceIds = [...new Set(mappings.map((m) => m.sourceConceptId).filter((id) => id > 0))]
  const targetIds = [...new Set(mappings.map((m) => m.targetConceptId).filter((id) => id > 0))]

  const [sourceCounts, targetCounts] = await Promise.all([
    countConcepts(targetDsId, sourceIds, 'source'),
    countConcepts(targetDsId, targetIds, 'standard'),
  ])

  const expected = expectedRowsByTarget(mappings, sourceCounts)

  return mappings.map((m) => {
    const sc = sourceCounts.get(m.sourceConceptId) ?? { patients: 0, rows: 0 }
    const tc = targetCounts.get(m.targetConceptId) ?? { patients: 0, rows: 0 }
    const expectedRows = expected.get(m.targetConceptId) ?? 0
    return {
      ...m,
      sourcePatients: sc.patients,
      sourceRows: sc.rows,
      targetPatients: tc.patients,
      targetRows: tc.rows,
      expectedRows,
      diff: classifyDiff(sc.rows, tc.rows, expectedRows),
    }
  })
}

/** Patients and rows per concept id, summed over the OMOP clinical tables. */
async function countConcepts(
  dataSourceId: string,
  conceptIds: number[],
  side: 'source' | 'standard',
): Promise<Map<number, ConceptCount>> {
  const counts = new Map<number, ConceptCount>()
  // Ids are interpolated into an IN (...), so they must be proven integers.
  if (conceptIds.length === 0 || !validateIntegerIds(conceptIds)) return counts
  const idList = conceptIds.join(',')

  for (const ct of CLINICAL_TABLES) {
    const col = side === 'source' ? ct.source : ct.standard
    try {
      const rows = await duckdbEngine.queryDataSource(dataSourceId, `
        SELECT "${col}" AS cid,
               COUNT(DISTINCT person_id)::INTEGER AS patients,
               COUNT(*)::INTEGER AS rows
        FROM "${ct.table}"
        WHERE "${col}" IN (${idList})
        GROUP BY "${col}"
      `)
      for (const r of rows) {
        const cid = Number(r.cid)
        const prev = counts.get(cid) ?? { patients: 0, rows: 0 }
        counts.set(cid, {
          patients: prev.patients + Number(r.patients),
          rows: prev.rows + Number(r.rows),
        })
      }
    } catch {
      // The table may not exist in this target — not every pipeline fills all of OMOP.
    }
  }
  return counts
}
