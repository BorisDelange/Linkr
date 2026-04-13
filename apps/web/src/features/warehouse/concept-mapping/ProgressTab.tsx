import { useMemo, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Maximize2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { queryDataSource, isFileSourceMounted, fileSourceDataSourceId, mountFileSourceIntoDuckDB } from '@/lib/duckdb/engine'
import { buildSourceConceptsCountQuery, buildFileSourceConceptsCountQuery } from '@/lib/concept-mapping/mapping-queries'
import type { MappingProject, MappingStatus, DataSource, ConceptMapping } from '@/types'

interface ProgressTabProps {
  project: MappingProject
  dataSource?: DataSource
}

const STATUS_COLORS: Record<MappingStatus, string> = {
  unchecked: '#94a3b8',
  approved: '#34d399',
  rejected: '#ef4444',
  flagged: '#fb923c',
  invalid: '#f87171',
  ignored: '#a78bfa',
}

export function ProgressTab({ project, dataSource }: ProgressTabProps) {
  const { t } = useTranslation()
  const { mappings } = useConceptMappingStore()
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  const isFileSource = project.sourceType === 'file'
  const [categoryModalOpen, setCategoryModalOpen] = useState(false)

  // Total source concept count from the database or file
  const [totalSourceConcepts, setTotalSourceConcepts] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        if (isFileSource) {
          // File source: count via DuckDB
          if (!project.fileSourceData) return
          if (!isFileSourceMounted(project.id)) {
            await mountFileSourceIntoDuckDB(project.id, project.fileSourceData.rows, project.fileSourceData.columnMapping, project.fileSourceData.rawFileBuffer)
          }
          const dsId = fileSourceDataSourceId(project.id)
          const sql = buildFileSourceConceptsCountQuery({})
          const [row] = await queryDataSource(dsId, sql)
          if (!cancelled) setTotalSourceConcepts(Number(row?.total ?? 0))
        } else {
          if (!dataSource?.id || !dataSource.schemaMapping) return
          await ensureMounted(dataSource.id)
          const sql = buildSourceConceptsCountQuery(dataSource.schemaMapping!, {})
          if (!sql) return
          const [row] = await queryDataSource(dataSource.id, sql)
          if (!cancelled) setTotalSourceConcepts(Number(row?.total ?? 0))
        }
      } catch {
        // silently fail
      }
    }
    load()
    return () => { cancelled = true }
  }, [isFileSource, project.id, project.fileSourceData, dataSource?.id, dataSource?.schemaMapping, ensureMounted])

  const stats = useMemo(() => {
    // Effective status per mapping (reviews majority vote, fallback to m.status)
    const effectiveStatus = (m: ConceptMapping): MappingStatus => {
      const reviews = m.reviews ?? []
      if (reviews.length === 0) return m.status
      const counts = { approved: 0, rejected: 0, flagged: 0, ignored: 0, unchecked: 0, invalid: 0 }
      for (const r of reviews) counts[r.status as MappingStatus] = (counts[r.status as MappingStatus] ?? 0) + 1
      const max = Math.max(...Object.values(counts))
      if (counts.approved === max) return 'approved'
      if (counts.rejected === max) return 'rejected'
      if (counts.flagged === max) return 'flagged'
      return m.status
    }

    // Unique source concept IDs (excluding ignored)
    const ignoredSourceIds = new Set(
      mappings.filter((m) => effectiveStatus(m) === 'ignored').map((m) => m.sourceConceptId),
    )
    const nonIgnoredMappings = mappings.filter((m) => effectiveStatus(m) !== 'ignored')
    const allSourceIds = new Set(nonIgnoredMappings.map((m) => m.sourceConceptId))

    // Best status per source concept
    const bestStatus = new Map<number, MappingStatus>()
    const statusPriority: MappingStatus[] = ['approved', 'flagged', 'rejected', 'unchecked', 'invalid', 'ignored']
    for (const m of nonIgnoredMappings) {
      const eff = effectiveStatus(m)
      const current = bestStatus.get(m.sourceConceptId)
      if (!current || statusPriority.indexOf(eff) < statusPriority.indexOf(current)) {
        bestStatus.set(m.sourceConceptId, eff)
      }
    }

    // Source concept status distribution
    const sourceStatusCounts: Record<string, number> = {}
    for (const [, status] of bestStatus) {
      sourceStatusCounts[status] = (sourceStatusCounts[status] ?? 0) + 1
    }

    // Category breakdown
    const domainMapped = new Map<string, Set<number>>()
    for (const m of mappings) {
      const domain = m.sourceCategoryId || t('concept_mapping.prog_domain_unknown')
      if (!domainMapped.has(domain)) domainMapped.set(domain, new Set())
      domainMapped.get(domain)!.add(m.sourceConceptId)
    }

    // Recent activity (last 10)
    const recent = [...mappings]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10)

    return {
      totalMappings: mappings.length,
      uniqueSourceConcepts: allSourceIds.size,
      approvedCount: sourceStatusCounts.approved ?? 0,
      flaggedCount: sourceStatusCounts.flagged ?? 0,
      ignoredCount: ignoredSourceIds.size,
      sourceStatusCounts,
      domainData: Array.from(domainMapped.entries()).map(([domain, ids]) => ({
        domain,
        count: ids.size,
      })).sort((a, b) => b.count - a.count),
      recent,
    }
  }, [mappings, t])

  const pieData = Object.entries(stats.sourceStatusCounts).map(([status, count]) => ({
    name: t(`concept_mapping.status_${status}`),
    value: count,
    color: STATUS_COLORS[status as MappingStatus] ?? '#9ca3af',
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
        color: '#e2e8f0',
      })
    }
  }

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
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-[220px] items-center justify-center">
                <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_no_data')}</p>
              </div>
            )}
          </Card>

          {/* Category breakdown bar chart */}
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">{t('concept_mapping.prog_domain_breakdown')}</p>
              {stats.domainData.length > 10 && (
                <Button variant="ghost" size="icon" className="h-6 w-6" title={t('concept_mapping.prog_category_show_all')} onClick={() => setCategoryModalOpen(true)}>
                  <Maximize2 size={13} />
                </Button>
              )}
            </div>
            {stats.domainData.length > 0 ? (
              <ResponsiveContainer width="100%" height={Math.max(180, stats.domainData.slice(0, 10).length * 26 + 20)}>
                <BarChart data={stats.domainData.slice(0, 10)} layout="vertical" margin={{ left: 90 }}>
                  <XAxis type="number" tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="domain" tick={{ fontSize: 10 }} width={90} interval={0} />
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
                    cursor={{ fill: 'var(--color-accent)' }}
                  />
                  <Bar dataKey="count" fill="#60a5fa" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
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

      {/* Category breakdown full modal */}
      <Dialog open={categoryModalOpen} onOpenChange={setCategoryModalOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium">{t('concept_mapping.prog_domain_breakdown')}</DialogTitle>
          </DialogHeader>
          <div className="overflow-auto">
            <ResponsiveContainer width="100%" height={Math.max(300, stats.domainData.length * 26 + 20)}>
              <BarChart data={stats.domainData} layout="vertical" margin={{ left: 120 }}>
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="domain" tick={{ fontSize: 11 }} width={120} interval={0} />
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
                  cursor={{ fill: 'var(--color-accent)' }}
                />
                <Bar dataKey="count" fill="#60a5fa" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
