import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Card } from '@/components/ui/card'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import type { MappingProject, MappingStatus } from '@/types'

interface ProgressTabProps {
  project: MappingProject
}

const STATUS_COLORS: Record<MappingStatus, string> = {
  unchecked: '#9ca3af',
  approved: '#34d399',
  rejected: '#ef4444',
  flagged: '#fb923c',
  invalid: '#f87171',
  ignored: '#d1d5db',
}

export function ProgressTab({ project }: ProgressTabProps) {
  const { t } = useTranslation()
  const { mappings, conceptSets } = useConceptMappingStore()

  const stats = useMemo(() => {
    // Unique source concept IDs
    const allSourceIds = new Set(mappings.map((m) => m.sourceConceptId))

    // Status distribution (by mapping)
    const statusCounts: Record<string, number> = {}
    for (const m of mappings) {
      statusCounts[m.status] = (statusCounts[m.status] ?? 0) + 1
    }

    // Best status per source concept
    const bestStatus = new Map<number, MappingStatus>()
    const statusPriority: MappingStatus[] = ['approved', 'flagged', 'rejected', 'unchecked', 'invalid', 'ignored']
    for (const m of mappings) {
      const current = bestStatus.get(m.sourceConceptId)
      if (!current || statusPriority.indexOf(m.status) < statusPriority.indexOf(current)) {
        bestStatus.set(m.sourceConceptId, m.status)
      }
    }

    // Source concept status distribution
    const sourceStatusCounts: Record<string, number> = {}
    for (const [, status] of bestStatus) {
      sourceStatusCounts[status] = (sourceStatusCounts[status] ?? 0) + 1
    }

    // Domain breakdown
    const domainMapped = new Map<string, Set<number>>()
    for (const m of mappings) {
      const domain = m.sourceDomainId || 'Unknown'
      if (!domainMapped.has(domain)) domainMapped.set(domain, new Set())
      domainMapped.get(domain)!.add(m.sourceConceptId)
    }

    // Concept set progress
    const linkedSets = conceptSets.filter((cs) => project.conceptSetIds.includes(cs.id))
    const conceptSetProgress = linkedSets.map((cs) => {
      const csConceptIds = new Set(
        cs.resolvedConceptIds ?? cs.expression.items.map((i) => i.concept.conceptId),
      )
      const mappedInCs = mappings.filter(
        (m) => m.status === 'approved' && csConceptIds.has(m.targetConceptId),
      )
      return {
        id: cs.id,
        name: cs.name,
        total: csConceptIds.size,
        mapped: new Set(mappedInCs.map((m) => m.sourceConceptId)).size,
      }
    })

    // Recent activity (last 10)
    const recent = [...mappings]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10)

    return {
      totalMappings: mappings.length,
      uniqueSourceConcepts: allSourceIds.size,
      approvedCount: sourceStatusCounts.approved ?? 0,
      flaggedCount: sourceStatusCounts.flagged ?? 0,
      statusCounts,
      sourceStatusCounts,
      domainData: Array.from(domainMapped.entries()).map(([domain, ids]) => ({
        domain,
        count: ids.size,
      })).sort((a, b) => b.count - a.count),
      conceptSetProgress,
      recent,
    }
  }, [mappings, conceptSets, project.conceptSetIds])

  const pieData = Object.entries(stats.sourceStatusCounts).map(([status, count]) => ({
    name: t(`concept_mapping.status_${status}`),
    value: count,
    color: STATUS_COLORS[status as MappingStatus] ?? '#9ca3af',
  }))

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Big numbers */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold">{stats.totalMappings}</p>
            <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_total_mappings')}</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold">{stats.uniqueSourceConcepts}</p>
            <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_source_concepts')}</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold text-green-600">{stats.approvedCount}</p>
            <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_approved')}</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold text-orange-500">{stats.flaggedCount}</p>
            <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_flagged')}</p>
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
                    paddingAngle={2}
                  >
                    {pieData.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
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

          {/* Domain breakdown bar chart */}
          <Card className="p-4">
            <p className="mb-3 text-sm font-medium">{t('concept_mapping.prog_domain_breakdown')}</p>
            {stats.domainData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={stats.domainData} layout="vertical" margin={{ left: 80 }}>
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="domain" tick={{ fontSize: 11 }} width={80} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#60a5fa" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-[220px] items-center justify-center">
                <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_no_data')}</p>
              </div>
            )}
          </Card>
        </div>

        {/* Concept set progress */}
        {stats.conceptSetProgress.length > 0 && (
          <Card className="p-4">
            <p className="mb-3 text-sm font-medium">{t('concept_mapping.prog_concept_set_progress')}</p>
            <div className="space-y-3">
              {stats.conceptSetProgress.map((cs) => {
                const pct = cs.total > 0 ? Math.round((cs.mapped / cs.total) * 100) : 0
                return (
                  <div key={cs.id}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium">{cs.name}</span>
                      <span className="text-muted-foreground">
                        {cs.mapped}/{cs.total} ({pct}%)
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-green-500 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
        )}

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
    </div>
  )
}
