import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Database,
  Loader2,
  RefreshCw,
  Table2,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  ConceptDataTable,
  TruncatedText,
  type ConceptColumn,
} from '@/components/ui/concept-data-table'
import { cn } from '@/lib/utils'
import { localized } from '@/lib/localized'
import { isServerMode } from '@/lib/api-client'
import * as duckdbEngine from '@/lib/duckdb/engine'
import { computeDatabaseStats } from '@/lib/duckdb/database-stats'
import { validateIntegerIds } from '@/lib/format-helpers'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import {
  classifyDiff,
  CLINICAL_TABLES,
  countByDiff,
  expectedRowsByTarget,
  type ConceptCount,
  type QualityConceptRow,
  type QualityDiff,
} from './quality-diff'
import type { DatabaseStatsCache, DataSource } from '@/types'

type QualityTab = 'statistics' | 'concepts'

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
  const { t, i18n } = useTranslation()
  const { etlPipelines, updatePipeline } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const [activeTab, setActiveTab] = useState<QualityTab>('statistics')

  const pipeline = etlPipelines.find((p) => p.id === pipelineId)
  const sourceDs = dataSources.find((ds) => ds.id === pipeline?.sourceDataSourceId)
  const targetDs = dataSources.find((ds) => ds.id === pipeline?.targetDataSourceId)

  const { mappingProjects, mappingProjectsLoaded, loadMappingProjects } = useConceptMappingStore()
  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
  }, [mappingProjectsLoaded, loadMappingProjects])

  const workspaceId = pipeline?.workspaceId
  const availableProjects = useMemo(
    () => mappingProjects.filter((p) => !workspaceId || p.workspaceId === workspaceId),
    [mappingProjects, workspaceId],
  )

  const mappingProjectId = pipeline?.mappingProjectId
  const setMappingProjectId = useCallback((id: string) => {
    if (pipeline) updatePipeline(pipeline.id, { mappingProjectId: id || undefined })
  }, [pipeline, updatePipeline])

  useEffect(() => {
    if (!mappingProjectId && availableProjects.length > 0) {
      setMappingProjectId(availableProjects[0].id)
    }
  }, [mappingProjectId, availableProjects, setMappingProjectId])

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
              onClick={() => setActiveTab(tab)}
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

          {activeTab === 'concepts' && availableProjects.length > 0 && (
            <div className="ml-auto">
              <Select value={mappingProjectId ?? ''} onValueChange={setMappingProjectId}>
                <SelectTrigger className="h-6 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/50">
                  <SelectValue placeholder={t('etl.vocab_select_project')} />
                </SelectTrigger>
                <SelectContent>
                  {availableProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {localized(p.name, i18n.language)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="min-h-0 min-w-0 flex-1">
          {activeTab === 'statistics'
            ? <StatisticsView sourceDs={sourceDs} targetDs={targetDs} />
            : <ConceptQualityView targetDs={targetDs} />}
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
}: {
  sourceDs: DataSource | undefined
  targetDs: DataSource | undefined
}) {
  const { t } = useTranslation()
  const [sourceStats, setSourceStats] = useState<DatabaseStatsCache | null>(null)
  const [targetStats, setTargetStats] = useState<DatabaseStatsCache | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // Server mode: never auto-run COUNT(*) on potentially huge databases.
    if (isServerMode()) {
      setSourceStats(null)
      setTargetStats(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)

    const load = async () => {
      const results = await Promise.all([
        sourceDs?.id && sourceDs.schemaMapping
          ? computeDatabaseStats(sourceDs.id, sourceDs.schemaMapping).catch(() => null)
          : Promise.resolve(null),
        targetDs?.id && targetDs.schemaMapping
          ? computeDatabaseStats(targetDs.id, targetDs.schemaMapping).catch(() => null)
          : Promise.resolve(null),
      ])
      if (!cancelled) {
        setSourceStats(results[0])
        setTargetStats(results[1])
        setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [sourceDs?.id, sourceDs?.schemaMapping, targetDs?.id, targetDs?.schemaMapping])

  return (
    <ScrollArea className="h-full">
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
        <StatsColumn label={t('etl.source')} ds={sourceDs} stats={sourceStats} loading={loading} accent="teal" />
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
  accent: 'teal' | 'emerald'
}) {
  const { t } = useTranslation()
  const borderColor = accent === 'teal' ? 'border-teal-500/30' : 'border-emerald-500/30'
  const iconColor = accent === 'teal' ? 'text-teal-500' : 'text-emerald-500'

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

      {stats && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <StatBox icon={<Users size={12} className="text-blue-500" />} value={stats.summary.patientCount} label={t('etl.sidebar_patients')} />
            <StatBox icon={<Activity size={12} className="text-emerald-500" />} value={stats.summary.visitCount} label={t('etl.sidebar_visits')} />
            <StatBox icon={<Building2 size={12} className="text-amber-500" />} value={stats.summary.visitDetailCount} label={t('etl.sidebar_visit_units')} />
          </div>

          {stats.tableCounts.length > 0 && (
            <div className="space-y-0.5">
              <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {t('etl.sidebar_tables')} ({stats.tableCounts.length})
              </h4>
              {stats.tableCounts.map((tc) => (
                <div key={tc.tableName} className="flex items-center gap-2 rounded px-1 py-0.5 text-[11px]">
                  <Table2 size={9} className="shrink-0 text-blue-500/60" />
                  <span className="min-w-0 flex-1 truncate font-mono">{tc.tableName}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{tc.rowCount.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatBox({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="rounded-md border p-2 text-center">
      <div className="mx-auto mb-0.5 flex justify-center">{icon}</div>
      <div className="text-sm font-semibold tabular-nums">{value.toLocaleString()}</div>
      <div className="text-[9px] text-muted-foreground">{label}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Concepts — per-concept source vs target counts
// ---------------------------------------------------------------------------

function ConceptQualityView({ targetDs }: { targetDs: DataSource | undefined }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<QualityConceptRow[]>([])
  const [loading, setLoading] = useState(false)
  const [diffFilter, setDiffFilter] = useState<QualityDiff | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!targetDs?.id) return
    let cancelled = false
    setLoading(true)

    const load = async () => {
      try {
        const loaded = await loadConceptQuality(targetDs.id)
        if (!cancelled) setRows(loaded)
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [targetDs?.id, reloadKey])

  const counts = useMemo(() => countByDiff(rows), [rows])
  const shown = useMemo(
    () => (diffFilter ? rows.filter((r) => r.diff === diffFilter) : rows),
    [rows, diffFilter],
  )

  const columns = useMemo((): ConceptColumn<QualityConceptRow>[] => [
    {
      id: 'diff',
      header: t('etl.comparison_status'),
      accessor: (r) => r.diff,
      cell: (r) => <DiffBadge diff={r.diff} />,
      filter: 'select',
      selectOptionLabel: (v) => t(`etl.comparison_${v}`, { defaultValue: v }),
      size: 90,
      center: true,
    },
    { id: 'sourceVocabularyId', header: t('etl.comparison_source_vocab'), accessor: (r) => r.sourceVocabularyId, filter: 'select', size: 150 },
    { id: 'sourceCode', header: t('etl.comparison_source_code'), accessor: (r) => r.sourceCode, filter: 'text', size: 120 },
    {
      id: 'sourceDescription',
      header: t('etl.comparison_description'),
      accessor: (r) => r.sourceDescription,
      cell: (r) => <TruncatedText>{r.sourceDescription}</TruncatedText>,
      filter: 'text',
      size: 260,
    },
    { id: 'sourcePatients', header: t('etl.comparison_source_patients'), accessor: (r) => r.sourcePatients, cell: (r) => num(r.sourcePatients), filter: 'number', size: 110 },
    { id: 'sourceRows', header: t('etl.comparison_source_rows'), accessor: (r) => r.sourceRows, cell: (r) => num(r.sourceRows), filter: 'number', size: 110 },
    { id: 'targetConceptId', header: t('etl.comparison_target_id'), accessor: (r) => r.targetConceptId, filter: 'number', size: 130 },
    { id: 'targetVocabularyId', header: t('etl.comparison_target_vocab'), accessor: (r) => r.targetVocabularyId, filter: 'select', size: 130 },
    { id: 'targetPatients', header: t('etl.comparison_target_patients'), accessor: (r) => r.targetPatients, cell: (r) => num(r.targetPatients), filter: 'number', size: 110 },
    { id: 'targetRows', header: t('etl.comparison_target_rows'), accessor: (r) => r.targetRows, cell: (r) => num(r.targetRows), filter: 'number', size: 110 },
  ], [t])

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
        <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => setReloadKey((k) => k + 1)}>
          <RefreshCw size={12} />
          {t('common.refresh')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Verdict chips: each is a filter, and the label says so — the previous
          bare "1394 OK" read as a count next to the total, which it is not. */}
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">{t('etl.comparison_filter_by')}</span>
        {(['missing', 'fewer', 'more', 'match'] as const).map((d) => (
          counts[d] > 0 && (
            <button
              key={d}
              onClick={() => setDiffFilter(diffFilter === d ? null : d)}
              aria-pressed={diffFilter === d}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors',
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
            className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted/80"
          >
            {t('etl.comparison_show_all')}
          </button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          onClick={() => setReloadKey((k) => k + 1)}
          title={t('common.refresh')}
        >
          <RefreshCw size={12} />
        </Button>
      </div>

      <div className="min-h-0 min-w-0 flex-1">
        <ConceptDataTable
          data={shown}
          columns={columns}
          rowKey={(r) => `${r.sourceVocabularyId}|${r.sourceCode}|${r.targetConceptId}`}
          emptyMessage={t('etl.comparison_no_mappings')}
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
    return {
      ...m,
      sourcePatients: sc.patients,
      sourceRows: sc.rows,
      targetPatients: tc.patients,
      targetRows: tc.rows,
      diff: classifyDiff(sc.rows, tc.rows, expected.get(m.targetConceptId) ?? 0),
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
