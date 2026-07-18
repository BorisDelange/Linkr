import { useMemo, useState, useEffect, useCallback, useRef, useTransition } from 'react'
import { useTranslation } from 'react-i18next'
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Maximize2, ArrowUp, ArrowDown, Search } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { queryDataSource, isFileSourceMounted, fileSourceDataSourceId, mountFileSourceIntoDuckDB } from '@/lib/duckdb/engine'
import {
  buildSourceConceptsCountQuery,
  buildFileSourceConceptsCountQuery,
  buildSourceConceptsGroupCountQuery,
  buildFileSourceConceptsGroupCountQuery,
  type BreakdownDimension,
} from '@/lib/concept-mapping/mapping-queries'
import { effectiveMappingStatus, sourceKey } from '@/lib/concept-mapping/mapping-status'
import { STATUS_COLORS, UNMAPPED_COLOR, STATUS_FALLBACK_COLOR } from '@/lib/concept-mapping/status-colors'
import { StatusBar, type StatusSegment } from './components/StatusBar'
import type { MappingProject, MappingStatus, EffectiveMappingStatus, DataSource } from '@/types'

interface ProgressTabProps {
  project: MappingProject
  dataSource?: DataSource
}

/**
 * Order in which status segments stack inside a breakdown bar (best → worst → untouched).
 * 'suggested' is intentionally absent: it's not a mapped state (see stats), so those
 * concepts fall into the 'unmapped' remainder rather than getting their own slice.
 */
const STATUS_SEGMENT_ORDER: (EffectiveMappingStatus | 'unmapped')[] = [
  'approved', 'flagged', 'disputed', 'rejected', 'invalid', 'unchecked', 'ignored', 'unmapped',
]

type BreakdownRow = {
  key: string
  total: number
  mapped: number
  approved: number
  byStatus: Record<string, number>
}

export function ProgressTab({ project, dataSource }: ProgressTabProps) {
  const { t } = useTranslation()
  const { mappings } = useConceptMappingStore()
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  const isFileSource = project.sourceType === 'file'

  // Breakdown card state. `breakdownDim` is the urgent value (tab highlight, painted
  // instantly); `deferredDim` drives the potentially heavy row recompute/render and is
  // updated inside a transition so the tab click responds immediately.
  const [breakdownDim, setBreakdownDim] = useState<BreakdownDimension>('vocabulary_id')
  const [deferredDim, setDeferredDim] = useState<BreakdownDimension>('vocabulary_id')
  const [, startDimTransition] = useTransition()
  const switchDim = useCallback((dim: BreakdownDimension) => {
    setBreakdownDim(dim)
    startDimTransition(() => setDeferredDim(dim))
  }, [])
  const [breakdownModalOpen, setBreakdownModalOpen] = useState(false)
  const [sortBy, setSortBy] = useState<'total' | 'mapped' | 'approved'>('total')
  const [sortDesc, setSortDesc] = useState(true)
  const [breakdownSearch, setBreakdownSearch] = useState('')
  // Debounced copy driving the filter — keeps typing fluid instead of re-filtering
  // the whole list on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(breakdownSearch), 200)
    return () => clearTimeout(id)
  }, [breakdownSearch])

  // Total source concept count from the database or file
  const [totalSourceConcepts, setTotalSourceConcepts] = useState<number | null>(null)
  // Per-group source-concept totals (full source, mapped + unmapped), keyed by group name.
  const [groupTotals, setGroupTotals] = useState<Record<BreakdownDimension, Map<string, number> | null>>({
    vocabulary_id: null,
    category: null,
  })

  // Each load bumps this; a load only commits its results if it's still the latest,
  // so a slow query resolving after the source/project changed can't overwrite fresh
  // stats (out-of-order response guard, also drops setState-after-unmount writes).
  const loadGen = useRef(0)
  const loadStats = useCallback(async () => {
    const gen = ++loadGen.current
    const toGroupMap = (rows: Record<string, unknown>[]): Map<string, number> => {
      const m = new Map<string, number>()
      for (const r of rows) {
        const key = r.group_key == null || r.group_key === '' ? t('concept_mapping.prog_domain_unknown') : String(r.group_key)
        m.set(key, (m.get(key) ?? 0) + Number(r.total ?? 0))
      }
      return m
    }
    try {
      if (isFileSource) {
        if (!project.fileSourceData) return
        if (!isFileSourceMounted(project.id)) {
          await mountFileSourceIntoDuckDB(project.id, project.fileSourceData.rows, project.fileSourceData.columnMapping, project.fileSourceData.rawFileBuffer)
        }
        const dsId = fileSourceDataSourceId(project.id)
        const [row] = await queryDataSource(dsId, buildFileSourceConceptsCountQuery({}))

        const cm = project.fileSourceData.columnMapping
        const present = { vocabulary: !!cm.terminologyColumn, category: !!cm.categoryColumn }
        const next: Record<BreakdownDimension, Map<string, number>> = { vocabulary_id: new Map(), category: new Map() }
        for (const dim of ['vocabulary_id', 'category'] as BreakdownDimension[]) {
          const sql = buildFileSourceConceptsGroupCountQuery(dim, present)
          next[dim] = sql ? toGroupMap(await queryDataSource(dsId, sql)) : new Map()
        }
        if (gen !== loadGen.current) return
        setTotalSourceConcepts(Number(row?.total ?? 0))
        setGroupTotals(next)
      } else {
        if (!dataSource?.id || !dataSource.schemaMapping) return
        await ensureMounted(dataSource.id)
        const totalSql = buildSourceConceptsCountQuery(dataSource.schemaMapping, {})
        if (!totalSql) return
        const [row] = await queryDataSource(dataSource.id, totalSql)

        const next: Record<BreakdownDimension, Map<string, number>> = { vocabulary_id: new Map(), category: new Map() }
        for (const dim of ['vocabulary_id', 'category'] as BreakdownDimension[]) {
          const sql = buildSourceConceptsGroupCountQuery(dataSource.schemaMapping, dim)
          next[dim] = sql ? toGroupMap(await queryDataSource(dataSource.id, sql)) : new Map()
        }
        if (gen !== loadGen.current) return
        setTotalSourceConcepts(Number(row?.total ?? 0))
        setGroupTotals(next)
      }
    } catch {
      // silently fail
    }
  }, [isFileSource, project.id, project.fileSourceData, dataSource?.id, dataSource?.schemaMapping, ensureMounted, t])

  useEffect(() => { void loadStats() }, [loadStats])
  // Refresh on modal open so totals reflect any mappings changed since last load.
  useEffect(() => { if (breakdownModalOpen) void loadStats() }, [breakdownModalOpen, loadStats])

  const stats = useMemo(() => {
    // Dedup by (vocabularyId, conceptCode) — same key as Mapping Editor / Export.
    const ignoredSourceKeys = new Set(
      mappings.filter((m) => effectiveMappingStatus(m) === 'ignored').map(sourceKey),
    )
    // A 'suggested' mapping is not a confirmed mapping — a concept whose only
    // mapping is suggested counts as unmapped, everywhere on this tab (pie,
    // 'mapped' column, breakdown bar). So it's excluded from the "mapped" set
    // just like 'ignored'; a concept that also has a decided mapping still counts.
    const nonIgnoredMappings = mappings.filter((m) => {
      const eff = effectiveMappingStatus(m)
      return eff !== 'ignored' && eff !== 'suggested'
    })
    const allSourceKeys = new Set(nonIgnoredMappings.map(sourceKey))

    // Best status per source concept
    const bestStatus = new Map<string, EffectiveMappingStatus>()
    const statusPriority: EffectiveMappingStatus[] = ['approved', 'disputed', 'flagged', 'rejected', 'unchecked', 'invalid', 'ignored']
    for (const m of nonIgnoredMappings) {
      const eff = effectiveMappingStatus(m)
      const k = sourceKey(m)
      const current = bestStatus.get(k)
      if (!current || statusPriority.indexOf(eff) < statusPriority.indexOf(current)) {
        bestStatus.set(k, eff)
      }
    }

    // Source concept status distribution
    const sourceStatusCounts: Record<string, number> = {}
    for (const [, status] of bestStatus) {
      sourceStatusCounts[status] = (sourceStatusCounts[status] ?? 0) + 1
    }

    // Per-group status distribution (deduped by source key). We resolve one best
    // status per source concept (including ignored) and attribute it to the group
    // (vocabulary or category) that concept belongs to. The vocabulary/category name
    // is taken from the mapping's source fields — same key space as the group totals
    // loaded from the source table.
    const unknown = t('concept_mapping.prog_domain_unknown')
    const bestPerKey = new Map<string, { status: EffectiveMappingStatus; vocab: string; category: string }>()
    const priorityWithIgnored: EffectiveMappingStatus[] = ['approved', 'disputed', 'flagged', 'rejected', 'unchecked', 'invalid', 'ignored']
    for (const m of mappings) {
      const eff = effectiveMappingStatus(m)
      // 'suggested' is not a mapped state (see nonIgnoredMappings above) — it must
      // not seed a group's status distribution, or the breakdown bar would count
      // it as mapped and leave the pie/bar disagreeing.
      if (eff === 'suggested') continue
      const k = sourceKey(m)
      const cur = bestPerKey.get(k)
      const vocab = m.sourceVocabularyId || unknown
      const category = m.sourceCategoryId || unknown
      if (!cur || priorityWithIgnored.indexOf(eff) < priorityWithIgnored.indexOf(cur.status)) {
        bestPerKey.set(k, { status: eff, vocab, category })
      }
    }

    const groupStatus = (dim: 'vocab' | 'category') => {
      const byGroup = new Map<string, Record<string, number>>()
      for (const { status, vocab, category } of bestPerKey.values()) {
        const g = dim === 'vocab' ? vocab : category
        const rec = byGroup.get(g) ?? {}
        rec[status] = (rec[status] ?? 0) + 1
        byGroup.set(g, rec)
      }
      return byGroup
    }

    // Recent activity (last 10)
    const recent = [...mappings]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10)

    return {
      totalMappings: mappings.length,
      uniqueSourceConcepts: allSourceKeys.size,
      approvedCount: sourceStatusCounts.approved ?? 0,
      flaggedCount: sourceStatusCounts.flagged ?? 0,
      ignoredCount: ignoredSourceKeys.size,
      sourceStatusCounts,
      statusByVocab: groupStatus('vocab'),
      statusByCategory: groupStatus('category'),
      recent,
    }
  }, [mappings, t])

  const pieData = Object.entries(stats.sourceStatusCounts).map(([status, count]) => ({
    name: t(`concept_mapping.status_${status}`),
    value: count,
    color: STATUS_COLORS[status as MappingStatus] ?? STATUS_FALLBACK_COLOR,
  }))

  // Add "ignored" slice
  if (stats.ignoredCount > 0) {
    pieData.push({
      name: t('concept_mapping.status_ignored'),
      value: stats.ignoredCount,
      color: STATUS_COLORS.ignored,
    })
  }

  // Add "unmapped" slice to pie if we know the total (exclude ignored from unmapped)
  if (totalSourceConcepts !== null) {
    const unmappedCount = totalSourceConcepts - stats.uniqueSourceConcepts - stats.ignoredCount
    if (unmappedCount > 0) {
      pieData.push({
        name: t('concept_mapping.filter_unmapped'),
        value: unmappedCount,
        color: UNMAPPED_COLOR,
      })
    }
  }

  // Combine per-group status distribution (from the store) with per-group source
  // totals (from the source table) into the breakdown rows. `total` covers mapped
  // AND unmapped concepts; the unmapped segment is the remainder.
  const breakdownRows = useMemo<BreakdownRow[]>(() => {
    const statusMap = deferredDim === 'vocabulary_id' ? stats.statusByVocab : stats.statusByCategory
    const totals = groupTotals[deferredDim]
    // Union of group names seen in either the totals or the mappings.
    const names = new Set<string>([...(totals?.keys() ?? []), ...statusMap.keys()])
    const rows: BreakdownRow[] = []
    for (const name of names) {
      const byStatus = statusMap.get(name) ?? {}
      const mappedNonIgnored = Object.entries(byStatus)
        .filter(([s]) => s !== 'ignored')
        .reduce((sum, [, c]) => sum + c, 0)
      const ignored = byStatus.ignored ?? 0
      // Fall back to the mapped+ignored count when the source total is unknown
      // (e.g. a source column that can't be aggregated).
      const total = totals?.get(name) ?? mappedNonIgnored + ignored
      rows.push({
        key: name,
        total,
        mapped: mappedNonIgnored,
        approved: byStatus.approved ?? 0,
        byStatus,
      })
    }
    return rows
  }, [deferredDim, groupTotals, stats.statusByVocab, stats.statusByCategory])

  const sortedFilteredRows = useMemo<BreakdownRow[]>(() => {
    const q = debouncedSearch.trim().toLowerCase()
    const filtered = q ? breakdownRows.filter((r) => r.key.toLowerCase().includes(q)) : breakdownRows
    const dir = sortDesc ? -1 : 1
    return [...filtered].sort((a, b) => {
      const av = a[sortBy], bv = b[sortBy]
      if (av !== bv) return (av - bv) * dir
      return a.key.localeCompare(b.key)
    })
  }, [breakdownRows, debouncedSearch, sortBy, sortDesc])

  const toggleSort = (col: 'total' | 'mapped' | 'approved') => {
    if (sortBy === col) setSortDesc((d) => !d)
    else { setSortBy(col); setSortDesc(true) }
  }

  const buildSegments = (row: BreakdownRow): StatusSegment[] => {
    const mappedTotal = Object.values(row.byStatus).reduce((s, c) => s + c, 0)
    const unmapped = Math.max(0, row.total - mappedTotal)
    const withUnmapped: Record<string, number> = { ...row.byStatus, unmapped }
    return STATUS_SEGMENT_ORDER
      .map((status) => ({
        status,
        count: withUnmapped[status] ?? 0,
        label: status === 'unmapped' ? t('concept_mapping.filter_unmapped') : t(`concept_mapping.status_${status}`),
      }))
      .filter((s) => s.count > 0)
  }

  const renderBreakdownRows = (rows: BreakdownRow[]) => (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-xs font-medium" title={row.key}>{row.key}</span>
            <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
              <span title={t('concept_mapping.prog_col_mapped')}>{row.mapped.toLocaleString()}</span>
              <span className="text-emerald-600" title={t('concept_mapping.prog_col_approved')}>{row.approved.toLocaleString()}</span>
              <span className="text-foreground" title={t('concept_mapping.prog_col_total')}>/ {row.total.toLocaleString()}</span>
            </span>
          </div>
          <StatusBar segments={buildSegments(row)} total={row.total} />
        </div>
      ))}
      {rows.length === 0 && (
        <p className="py-6 text-center text-xs text-muted-foreground">{t('concept_mapping.prog_no_match')}</p>
      )}
    </div>
  )

  const renderSortHeader = (col: 'total' | 'mapped' | 'approved', label: string) => (
    <button
      key={col}
      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors hover:bg-accent ${sortBy === col ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
      onClick={() => toggleSort(col)}
    >
      {label}
      {sortBy === col && (sortDesc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
    </button>
  )

  const dimTabs = (
    <div className="flex rounded-md bg-muted p-0.5">
      {(['vocabulary_id', 'category'] as BreakdownDimension[]).map((dim) => (
        <button
          key={dim}
          className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${breakdownDim === dim ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={() => switchDim(dim)}
        >
          {dim === 'vocabulary_id' ? t('concept_mapping.prog_tab_vocabulary') : t('concept_mapping.prog_tab_category')}
        </button>
      ))}
    </div>
  )

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Big numbers */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold">{totalSourceConcepts !== null ? totalSourceConcepts.toLocaleString() : '—'}</p>
            <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_total_source_concepts')}</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold text-blue-600">
              {stats.uniqueSourceConcepts}
              {totalSourceConcepts !== null && totalSourceConcepts > 0 && (
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  ({Math.round((stats.uniqueSourceConcepts / totalSourceConcepts) * 100)}%)
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_source_concepts')}</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold text-green-600">
              {stats.approvedCount}
              {totalSourceConcepts !== null && totalSourceConcepts > 0 && (
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  ({Math.round((stats.approvedCount / totalSourceConcepts) * 100)}%)
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_approved')}</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold text-orange-500">{stats.flaggedCount}</p>
            <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_flagged')}</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold text-gray-500">{stats.ignoredCount}</p>
            <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_ignored')}</p>
          </Card>
        </div>

        {/* Charts row */}
        <div className="grid gap-4 md:grid-cols-2">
          {/* Status distribution pie */}
          <Card className="p-4">
            <p className="mb-3 text-sm font-medium">{t('concept_mapping.prog_status_distribution')}</p>
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={0}
                    minAngle={2}
                  >
                    {pieData.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--color-popover)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 6,
                      fontSize: 12,
                      color: 'var(--color-popover-foreground)',
                    }}
                    itemStyle={{ color: 'var(--color-popover-foreground)' }}
                    labelStyle={{ color: 'var(--color-popover-foreground)' }}
                  />
                  <Legend
                    layout="vertical"
                    align="right"
                    verticalAlign="middle"
                    iconSize={10}
                    wrapperStyle={{ fontSize: 11 }}
                    formatter={(value) => <span style={{ color: 'var(--color-foreground)' }}>{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-[220px] items-center justify-center">
                <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_no_data')}</p>
              </div>
            )}
          </Card>

          {/* Breakdown by vocabulary / category */}
          <Card className="p-4">
            <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <p className="text-sm font-medium">{t('concept_mapping.prog_breakdown')}</p>
              <div className="flex justify-center">{dimTabs}</div>
              <div className="flex justify-end">
                {breakdownRows.length > 0 && (
                  <Button variant="ghost" size="icon" className="h-6 w-6" title={t('concept_mapping.prog_show_all')} onClick={() => setBreakdownModalOpen(true)}>
                    <Maximize2 size={13} />
                  </Button>
                )}
              </div>
            </div>
            {breakdownRows.length > 0 ? (
              renderBreakdownRows(sortedFilteredRows.slice(0, 10))
            ) : (
              <div className="flex h-[180px] items-center justify-center">
                <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_no_data')}</p>
              </div>
            )}
          </Card>
        </div>

        {/* Recent activity */}
        {stats.recent.length > 0 && (
          <Card className="p-4">
            <p className="mb-3 text-sm font-medium">{t('concept_mapping.prog_recent_activity')}</p>
            <div className="space-y-2">
              {stats.recent.map((m) => (
                <div key={m.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{m.sourceConceptName}</span>
                    <span className="mx-1.5 text-muted-foreground">&rarr;</span>
                    <span>{m.targetConceptName}</span>
                  </div>
                  <div className="ml-3 flex shrink-0 items-center gap-2">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ backgroundColor: STATUS_COLORS[m.status] }}
                    />
                    {m.mappedBy && (
                      <span className="max-w-[100px] truncate text-muted-foreground" title={m.mappedBy}>{m.mappedBy}</span>
                    )}
                    <span className="text-muted-foreground">
                      {new Date(m.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Empty state */}
        {mappings.length === 0 && (
          <Card>
            <div className="flex flex-col items-center py-10">
              <p className="text-sm text-muted-foreground">{t('concept_mapping.prog_empty')}</p>
            </div>
          </Card>
        )}
      </div>

      {/* Breakdown full modal — sortable + searchable */}
      <Dialog open={breakdownModalOpen} onOpenChange={setBreakdownModalOpen}>
        <DialogContent className="sm:max-w-[720px] h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium">{t('concept_mapping.prog_breakdown')}</DialogTitle>
          </DialogHeader>
          <div className="flex justify-center">{dimTabs}</div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={breakdownSearch}
                onChange={(e) => setBreakdownSearch(e.target.value)}
                placeholder={t('concept_mapping.prog_search_placeholder')}
                className="h-7 w-48 pl-7 text-xs"
              />
            </div>
            <div className="flex items-center gap-0.5">
              {renderSortHeader('total', t('concept_mapping.prog_sort_total'))}
              {renderSortHeader('mapped', t('concept_mapping.prog_sort_mapped'))}
              {renderSortHeader('approved', t('concept_mapping.prog_sort_approved'))}
            </div>
          </div>
          <div className="mt-2 flex-1 overflow-y-auto min-h-0 pr-1">
            {renderBreakdownRows(sortedFilteredRows)}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
