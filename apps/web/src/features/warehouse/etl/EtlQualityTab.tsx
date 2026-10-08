import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NoticeBanner } from '@/components/ui/notice-banner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DataTable,
  type DataTableColumn,
} from '@/components/ui/data-table'
import { TruncatedText } from '@/components/ui/truncated-text'
import { cn } from '@/lib/utils'
import { getStorage } from '@/lib/storage'
import { computeDatabaseStats } from '@/lib/duckdb/database-stats'
import {
  countAllTables,
  loadTableCounts,
  notifyTableCounts,
  sortedCounts,
  subscribeTableCounts,
} from '@/lib/duckdb/table-counts'
import { formatDateTimeLocale } from '@/lib/format-helpers'
import { csvBlob, toCsv } from '@/lib/csv-export'
import { downloadBlob } from '@/lib/entity-io'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import {
  countByDiff,
  isQualityCacheUsable,
  qualityFingerprint,
  type QualityConceptRow,
  type QualityDiff,
} from './quality-diff'
import { loadConceptQuality } from './load-concept-quality'
import { QueryErrorNotice, StatsColumn } from './quality-stats-column'
import type { DatabaseStatsCache, DataSource } from '@/types'

type QualityTab = 'statistics' | 'concepts'

/** Sub-tab last looked at, so leaving and coming back lands where you were. */
let lastQualityTab: QualityTab = 'statistics'

interface Props {
  pipelineId: string
  /** Opens a script in the Scripts tab. */
  onOpenScript: (fileId: string) => void
  /** Opens the Vocabulary tab, where 00_vocabulary.sql is generated. */
  onOpenVocabulary: () => void
}

/**
 * Did the ETL do what the mapping said it would?
 *
 * Two views on the same question: overall figures for both databases side by
 * side, and per-concept counts comparing what arrived carrying a source concept
 * against what came out mapped to a standard one.
 */
export function EtlQualityTab({ pipelineId, onOpenScript, onOpenVocabulary }: Props) {
  const { t } = useTranslation()
  const { etlPipelines } = useEtlStore()
  // A run holds the target open for writing, so reading it fails until the run
  // ends. Both views wait for it instead of reporting an empty or broken target.
  const targetBusy = useEtlStore((s) => s.pipelineRunning)
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
            ? <StatisticsView sourceDs={sourceDs} targetDs={targetDs} targetBusy={targetBusy} onActions={setActions} />
            : (
              <ConceptQualityView
                pipelineId={pipelineId}
                targetDs={targetDs}
                targetBusy={targetBusy}
                onActions={setActions}
                onOpenScript={onOpenScript}
                onOpenVocabulary={onOpenVocabulary}
              />
            )}
        </div>
      </div>
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------------------
// Statistics — both databases side by side
// ---------------------------------------------------------------------------

type StatsResult = { stats: DatabaseStatsCache | null; error?: string }

function StatisticsView({
  sourceDs,
  targetDs,
  targetBusy,
  onActions,
}: {
  sourceDs: DataSource | undefined
  targetDs: DataSource | undefined
  targetBusy: boolean
  onActions: (node: React.ReactNode) => void
}) {
  const { t, i18n } = useTranslation()
  const [sourceStats, setSourceStats] = useState<DatabaseStatsCache | null>(null)
  const [targetStats, setTargetStats] = useState<DatabaseStatsCache | null>(null)
  const [sourceError, setSourceError] = useState<string>()
  const [targetError, setTargetError] = useState<string>()
  const [loading, setLoading] = useState(false)

  /**
   * Count one database and SAVE the result.
   *
   * The counts were recomputed on every visit and thrown away, so the work was
   * repeated for figures that only change when the pipeline runs. They now go to
   * databaseStatsCache — the same store the Databases page uses, backed by the
   * server's /stats-cache in server mode.
   */
  const computeOne = async (ds: DataSource | undefined): Promise<StatsResult> => {
    if (!ds?.id || !ds.schemaMapping) return { stats: null }
    try {
      const fresh = await computeDatabaseStats(ds.id, ds.schemaMapping)
      // Merge, not replace: tableCounts belong to the schema browser, which fills
      // them separately — overwriting with our empty list would erase them.
      const existing = await getStorage().databaseStatsCache.get(ds.id).catch(() => undefined)
      let tableCounts = fresh.tableCounts.length ? fresh.tableCounts : existing?.tableCounts ?? []
      await getStorage().databaseStatsCache.save({ ...fresh, tableCounts }).catch(() => {})

      // Count the tables here too when nobody has yet. The per-table list was
      // only ever filled by the schema browser, so a user who came straight to
      // Quality check got the clinical figures and an empty table list, with
      // nothing on screen saying which button would fill it.
      if (tableCounts.length === 0) {
        tableCounts = sortedCounts(await countAllTables(ds.id))
      } else {
        // Someone else may be showing these; keep them in step either way.
        notifyTableCounts(ds.id)
      }
      return { stats: { ...fresh, tableCounts } }
    } catch (e) {
      return { stats: null, error: errorText(e) }
    }
  }

  const applySource = (r: StatsResult) => { setSourceStats(r.stats); setSourceError(r.error) }
  const applyTarget = (r: StatsResult) => { setTargetStats(r.stats); setTargetError(r.error) }

  // Every computation takes a ticket; only the latest one applies its result, so
  // a slow count can never overwrite a newer one.
  const request = useRef(0)

  // A run that just ended has rewritten the target: its saved figures describe
  // the database before the run, so they are recounted rather than shown. Set
  // until that recount lands, so a re-run effect still knows.
  const wasBusy = useRef(targetBusy)
  const targetStale = useRef(false)

  const computeStats = useCallback(async () => {
    const ticket = ++request.current
    setLoading(true)
    const [src, tgt] = await Promise.all([
      computeOne(sourceDs),
      targetBusy ? Promise.resolve(null) : computeOne(targetDs),
    ])
    if (ticket !== request.current) return
    applySource(src)
    if (tgt) {
      applyTarget(tgt)
      targetStale.current = false
    }
    setLoading(false)
  // computeOne only reads the two data sources, both listed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceDs?.id, sourceDs?.schemaMapping, targetDs?.id, targetDs?.schemaMapping, targetBusy])

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
            <span className="truncate text-[10px] text-muted-foreground">
              {t('etl.quality_stats_computed_at', { when: formatDateTimeLocale(computedAt, i18n.language) })}
            </span>
          )}
          <Button
            size="sm-tight"
            variant={computedAt ? 'outline' : 'default'}
            className="shrink-0 px-2.5"
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
    if (wasBusy.current && !targetBusy) targetStale.current = true
    wasBusy.current = targetBusy
    const ticket = ++request.current
    setLoading(true)

    const load = async () => {
      // Saved counts first, whatever the mode: they are what the user computed
      // last, and showing them beats an empty card plus a fresh scan.
      const [srcCached, tgtCached] = await Promise.all([
        sourceDs?.id ? getStorage().databaseStatsCache.get(sourceDs.id).catch(() => undefined) : undefined,
        targetDs?.id ? getStorage().databaseStatsCache.get(targetDs.id).catch(() => undefined) : undefined,
      ])
      if (ticket !== request.current) return
      const staleTarget = targetStale.current
      setSourceStats(srcCached ?? null)
      setTargetStats(staleTarget ? null : tgtCached ?? null)

      // A side with a data model but no saved figures is computed on arrival,
      // in EVERY mode. Server mode used to withhold this to avoid COUNT(*) over
      // a huge database, which left the tab half-filled — one column of numbers
      // and one saying "not computed" — and the user had to find the button to
      // get the comparison the tab exists for. The guard that matters is the
      // saved result: once counted, arriving here costs nothing.
      const needsSource = !srcCached && !!sourceDs?.schemaMapping
      const needsTarget = (staleTarget || !tgtCached) && !!targetDs?.schemaMapping && !targetBusy
      if (!targetDs?.schemaMapping) targetStale.current = false
      if (!needsSource && !needsTarget) {
        setLoading(false)
        return
      }
      const [src, tgt] = await Promise.all([
        needsSource ? computeOne(sourceDs) : Promise.resolve({ stats: srcCached ?? null }),
        needsTarget ? computeOne(targetDs) : Promise.resolve(null),
      ])
      if (ticket !== request.current) return
      applySource(src)
      if (tgt) {
        applyTarget(tgt)
        targetStale.current = false
      } else if (!staleTarget) {
        applyTarget({ stats: tgtCached ?? null })
      }
      setLoading(false)
    }
    void load()
  // computeOne only reads the two data sources, both listed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceDs?.id, sourceDs?.schemaMapping, targetDs?.id, targetDs?.schemaMapping, targetBusy])

  // Counting from the Browse-schema tab writes the same cache entry, so the
  // table list here follows along instead of staying at whatever it was when
  // this view last computed.
  useEffect(() => {
    const adopt = (
      id: string | undefined,
      set: React.Dispatch<React.SetStateAction<DatabaseStatsCache | null>>,
    ) => {
      if (!id) return undefined
      const refresh = () => {
        void loadTableCounts(id).then((counts) => {
          set((prev) => (prev ? { ...prev, tableCounts: sortedCounts(counts) } : prev))
        })
      }
      return subscribeTableCounts(id, refresh)
    }
    const offSource = adopt(sourceDs?.id, setSourceStats)
    const offTarget = adopt(targetDs?.id, setTargetStats)
    return () => { offSource?.(); offTarget?.() }
  }, [sourceDs?.id, targetDs?.id])

  return (
    <ScrollArea className="h-full">
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
        <StatsColumn
          label={t('etl.source')} ds={sourceDs} stats={sourceStats} error={sourceError}
          loading={loading} accent="orange" onRetry={() => void computeStats()}
        />
        <StatsColumn
          label={t('etl.target')} ds={targetDs} stats={targetStats} error={targetError}
          busy={targetBusy} loading={loading} accent="emerald" onRetry={() => void computeStats()}
        />
      </div>
    </ScrollArea>
  )
}


// ---------------------------------------------------------------------------
// Concepts — per-concept source vs target counts
// ---------------------------------------------------------------------------

/**
 * The concept table, persisted per pipeline.
 *
 * It was a module-level Map: it survived a tab switch but died on reload, so
 * every visit paid for a dozen COUNT queries over the target again, and each
 * user paid separately. It now goes to etlQualityCache — the same shared store
 * pattern the Statistics view uses (server-side `stats_cache`, scope
 * `etl-quality`), which is what makes one member's computation serve everyone.
 *
 * Staleness is decided by a fingerprint (the last completed run) plus the target
 * database id, so a re-run or a repointed pipeline recomputes on its own. The
 * Refresh button forces it regardless.
 */
function ConceptQualityView({
  pipelineId,
  targetDs,
  targetBusy,
  onActions,
  onOpenScript,
  onOpenVocabulary,
}: {
  pipelineId: string
  targetDs: DataSource | undefined
  targetBusy: boolean
  onActions: (node: React.ReactNode) => void
  onOpenScript: (fileId: string) => void
  onOpenVocabulary: () => void
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  // `t` through a ref: the column array must not be rebuilt on every render (see
  // the memo below), but it must still translate with the current language.
  const tRef = useRef(t)
  tRef.current = t
  const targetId = targetDs?.id
  const runHistory = useEtlStore((s) => s.runHistory)
  const runHistoryLoaded = useEtlStore((s) => s.runHistoryLoaded)
  const [rows, setRows] = useState<QualityConceptRow[]>([])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [computedAt, setComputedAt] = useState<string | null>(null)
  const [diffFilter, setDiffFilter] = useState<QualityDiff | null>(null)

  const fingerprint = useMemo(() => qualityFingerprint(runHistory), [runHistory])

  const load = useCallback(async (force: boolean) => {
    if (!targetId) return
    if (!force) {
      const cached = await getStorage().etlQualityCache.get(pipelineId).catch(() => undefined)
      if (isQualityCacheUsable(cached, targetId, fingerprint)) {
        setRows((cached!.rows ?? []) as QualityConceptRow[])
        setComputedAt(cached!.computedAt)
        return
      }
    }
    setLoading(true)
    setError(undefined)
    try {
      const loaded = await loadConceptQuality(targetId)
      const at = new Date().toISOString()
      setRows(loaded)
      setComputedAt(at)
      await getStorage().etlQualityCache.save({
        pipelineId,
        computedAt: at,
        targetDataSourceId: targetId,
        fingerprint,
        rows: loaded,
      }).catch(() => {})
    } catch (e) {
      setRows([])
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [pipelineId, targetId, fingerprint])

  // Gated on the history being read: the fingerprint keys on the last run, so
  // firing early would compute against 'none' and then recompute a moment later.
  // Held while a run writes the target; the run's end changes the fingerprint,
  // which recounts on its own.
  useEffect(() => {
    if (runHistoryLoaded && !targetBusy) void load(false)
  }, [load, runHistoryLoaded, targetBusy])

  // The script that fills the mappings, to open it straight from the empty state.
  const vocabularyScriptId = useEtlStore((s) => s.files.find(
    (f) => f.pipelineId === pipelineId && f.type === 'file' && f.name === VOCABULARY_SCRIPT,
  )?.id)

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
        <span className="shrink-0 text-[10px] text-muted-foreground">{t('etl.comparison_filter_by')}</span>
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
        {/* When it was counted, as in Statistics — the table is cached now, so a
            stale figure has to be recognisable as one. */}
        {computedAt && (
          <span className="truncate text-[10px] text-muted-foreground">
            {t('etl.quality_stats_computed_at', { when: formatDateTimeLocale(computedAt, i18n.language) })}
          </span>
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
  }, [onActions, counts, diffFilter, shown.length, exportCsv, load, computedAt, t, i18n.language])

  const columns = useMemo((): DataTableColumn<QualityConceptRow>[] => [
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
      cell: (r) => <TruncatedText text={r.sourceDescription} />,
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

  if (targetBusy) {
    return (
      <div className="mx-auto flex h-full max-w-xl flex-col justify-center p-6">
        <NoticeBanner tone="progress" title={t('etl.quality_concepts_target_busy')} />
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        {t('common.loading')}…
      </div>
    )
  }

  if (error) {
    return (
      <div className="mx-auto flex h-full max-w-xl flex-col justify-center p-6">
        <QueryErrorNotice text={t('etl.quality_concepts_failed')} error={error} onRetry={() => void load(true)} />
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm">{t('etl.comparison_no_mappings_title')}</p>
        <p className="text-xs text-muted-foreground">
          {vocabularyScriptId
            ? t('etl.comparison_no_mappings_run', { script: VOCABULARY_SCRIPT })
            : t('etl.comparison_no_mappings_generate', { script: VOCABULARY_SCRIPT })}
        </p>
        <div className="flex items-center gap-2">
          {vocabularyScriptId ? (
            <Button size="sm" onClick={() => onOpenScript(vocabularyScriptId)}>
              {t('etl.comparison_open_script', { script: VOCABULARY_SCRIPT })}
            </Button>
          ) : (
            <Button size="sm" onClick={onOpenVocabulary}>{t('etl.comparison_open_vocabulary')}</Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void load(true)}>
            <RefreshCw size={12} />
            {t('common.refresh')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="min-h-0 min-w-0 flex-1">
        <DataTable
          cellTooltips="all"
          data={shown}
          columns={columns}
          rowKey={(r) => `${r.sourceVocabularyId}|${r.sourceCode}|${r.targetConceptId}`}
          emptyMessage={t('etl.comparison_no_mappings_title')}
          // A dictionary runs to thousands of mappings; rendering a DOM row for
          // each is what made sorting and resizing crawl.
          pageSize={100}
          // Biggest source volumes first: those are the mappings whose gaps matter.
          initialSorting={{ columnId: 'sourceRows', desc: true }}
          // Eleven columns, and which ones matter depends on what you're chasing.
          reorderable
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


const VOCABULARY_SCRIPT = '00_vocabulary.sql'

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

