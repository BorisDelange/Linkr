import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileText, FileSpreadsheet, FileCode, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  exportToUsagiCsv,
  exportToSourceToConceptMap,
  exportToSssomTsv,
  exportSourceConceptsCsv,
  buildSourceConceptsCsvFromRows,
  downloadFile,
} from '@/lib/concept-mapping/export'
import { buildSourceConceptsAllQuery } from '@/lib/concept-mapping/mapping-queries'
import { getStorage } from '@/lib/storage'
import { Table2 } from 'lucide-react'
import type { MappingProject, MappingStatus, DataSource } from '@/types'

interface ExportTabProps {
  project: MappingProject
  dataSource?: DataSource
}

type ApprovalRule = 'at_least_one' | 'majority' | 'no_rejections'

const STATUSES: MappingStatus[] = ['approved', 'rejected', 'flagged', 'unchecked', 'ignored']

export function ExportTab({ project, dataSource }: ExportTabProps) {
  const { t } = useTranslation()
  const { mappings } = useConceptMappingStore()
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const [sourceExporting, setSourceExporting] = useState(false)

  // Status checkboxes (approved checked by default)
  const [includedStatuses, setIncludedStatuses] = useState<Set<MappingStatus>>(
    new Set(['approved']),
  )
  const [approvalRule, setApprovalRule] = useState<ApprovalRule>('at_least_one')

  const toggleStatus = (status: MappingStatus) => {
    setIncludedStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  // Count per status
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const m of mappings) {
      counts[m.status] = (counts[m.status] ?? 0) + 1
    }
    return counts
  }, [mappings])

  const filteredMappings = useMemo(() => {
    // First filter: status checkboxes
    let result = mappings.filter((m) => {
      if (m.status === 'approved') {
        // "Approved" checkbox must be on
        if (!includedStatuses.has('approved')) return false
        return true
      }
      return includedStatuses.has(m.status)
    })

    // Then apply approval sub-rule for approved mappings
    if (includedStatuses.has('approved') && approvalRule !== 'at_least_one') {
      // Group all mappings by sourceConceptId to check cross-mapping status
      const sourceConceptStatuses = new Map<number, MappingStatus[]>()
      for (const m of mappings) {
        const arr = sourceConceptStatuses.get(m.sourceConceptId) ?? []
        arr.push(m.status)
        sourceConceptStatuses.set(m.sourceConceptId, arr)
      }

      result = result.filter((m) => {
        if (m.status !== 'approved') return true // only filter approved ones
        const statuses = sourceConceptStatuses.get(m.sourceConceptId) ?? []
        const approvedCount = statuses.filter((s) => s === 'approved').length
        const rejectedCount = statuses.filter((s) => s === 'rejected').length

        if (approvalRule === 'majority') {
          return approvedCount > rejectedCount
        }
        if (approvalRule === 'no_rejections') {
          return rejectedCount === 0
        }
        return true
      })
    }

    return result
  }, [mappings, includedStatuses, approvalRule])

  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  const formats = [
    {
      id: 'sssom',
      icon: FileCode,
      name: t('concept_mapping.export_sssom'),
      description: t('concept_mapping.export_sssom_desc'),
      ext: 'tsv',
      mime: 'text/tab-separated-values',
      color: 'text-violet-500',
      bg: 'bg-violet-50 dark:bg-violet-950/30',
      generate: () => exportToSssomTsv(filteredMappings, project),
    },
    {
      id: 'source_to_concept_map',
      icon: FileText,
      name: t('concept_mapping.export_stcm'),
      description: t('concept_mapping.export_stcm_desc'),
      ext: 'csv',
      mime: 'text/csv',
      color: 'text-blue-500',
      bg: 'bg-blue-50 dark:bg-blue-950/30',
      generate: async () => {
        // Load registry entries for the project's badge labels
        const badgeLabels = (project.badges ?? []).map((b) => b.label).filter(Boolean)
        let registryEntries = undefined
        if (badgeLabels.length > 0 && project.workspaceId) {
          const allEntries = await Promise.all(
            badgeLabels.map((label) => getStorage().sourceConceptIdEntries.getByWorkspaceAndBadge(project.workspaceId, label)),
          )
          const flat = allEntries.flat()
          if (flat.length > 0) registryEntries = flat
        }
        return exportToSourceToConceptMap(filteredMappings, project, registryEntries)
      },
    },
    {
      id: 'usagi',
      icon: FileSpreadsheet,
      name: t('concept_mapping.export_usagi'),
      description: t('concept_mapping.export_usagi_desc'),
      ext: 'csv',
      mime: 'text/csv',
      color: 'text-emerald-500',
      bg: 'bg-emerald-50 dark:bg-emerald-950/30',
      generate: () => exportToUsagiCsv(filteredMappings),
    },
    // Source concepts CSV — file-based projects
    ...(project.sourceType === 'file' && project.fileSourceData ? [{
      id: 'source-concepts',
      icon: Table2,
      name: t('concept_mapping.export_source_csv'),
      description: t('concept_mapping.export_source_csv_desc'),
      ext: 'csv',
      mime: 'text/csv',
      color: 'text-amber-500',
      bg: 'bg-amber-50 dark:bg-amber-950/30',
      generate: () => exportSourceConceptsCsv(
        project.fileSourceData!.rows,
        project.fileSourceData!.columns,
        project.fileSourceData!.columnMapping,
      ),
      alwaysEnabled: true,
    }] : []),
  ]

  const handleDownload = async (format: (typeof formats)[number]) => {
    const content = await format.generate()
    const filename = `${slug}-${format.id}.${format.ext}`
    downloadFile(content, filename, format.mime)
  }

  const handleExportSourceDb = async () => {
    if (!dataSource?.id || !dataSource.schemaMapping) return
    setSourceExporting(true)
    try {
      await ensureMounted(dataSource.id)
      const sql = buildSourceConceptsAllQuery(dataSource.schemaMapping, {})
      if (!sql) return
      const rows = await queryDataSource(dataSource.id, sql)
      if (rows.length === 0) return
      downloadFile(buildSourceConceptsCsvFromRows(rows), `${slug}-source-concepts.csv`, 'text/csv')
    } finally {
      setSourceExporting(false)
    }
  }

  const totalExportCount = filteredMappings.length

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Status filter section */}
        <Card className="p-4">
          <p className="mb-3 text-sm font-medium">{t('concept_mapping.export_filter_title')}</p>

          {/* Status checkboxes */}
          <div className="space-y-2">
            {STATUSES.map((status) => {
              const count = statusCounts[status] ?? 0
              const checked = includedStatuses.has(status)
              return (
                <div key={status}>
                  <label className="flex cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleStatus(status)}
                      className="size-3.5 rounded border-gray-300 accent-primary"
                    />
                    <span className="text-xs">{t(`concept_mapping.status_${status}`)}</span>
                    <Badge variant="secondary" className="text-[10px]">{count}</Badge>
                  </label>

                  {/* Approval sub-rules (only shown when approved is checked) */}
                  {status === 'approved' && checked && (
                    <div className="ml-6 mt-1.5 space-y-1">
                      {(['at_least_one', 'majority', 'no_rejections'] as ApprovalRule[]).map((rule) => (
                        <label key={rule} className="flex cursor-pointer items-center gap-2">
                          <input
                            type="radio"
                            name="approval-rule"
                            checked={approvalRule === rule}
                            onChange={() => setApprovalRule(rule)}
                            className="size-3 accent-primary"
                          />
                          <span className="text-[11px] text-muted-foreground">
                            {t(`concept_mapping.export_rule_${rule}`)}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

          </div>

          <div className="mt-3 border-t pt-3">
            <p className="text-xs text-muted-foreground">
              {t('concept_mapping.export_total')}: <strong>{totalExportCount}</strong> {t('concept_mapping.export_mappings_count')}
            </p>
          </div>
        </Card>

        {/* Format cards */}
        <div className="grid gap-3 sm:grid-cols-2">
          {formats.map((format) => (
            <Card key={format.id} className="flex flex-col justify-between overflow-hidden p-0">
              <div className={`flex items-center gap-2.5 px-4 py-3 ${format.bg}`}>
                <format.icon size={16} className={`shrink-0 ${format.color}`} />
                <span className="text-sm font-medium">{format.name}</span>
                <Badge variant="outline" className="text-[10px] ml-auto">.{format.ext}</Badge>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">{format.description}</p>
              </div>
              <div className="px-4 pb-4">
                <Button
                  className="w-full"
                  variant="outline"
                  size="sm"
                  onClick={() => handleDownload(format)}
                  disabled={totalExportCount === 0 && !('alwaysEnabled' in format && format.alwaysEnabled)}
                >
                  <Download size={14} />
                  {t('concept_mapping.export_download')}
                </Button>
              </div>
            </Card>
          ))}

          {/* Source concepts CSV — database projects */}
          {project.sourceType !== 'file' && dataSource?.schemaMapping && (
            <Card className="flex flex-col justify-between overflow-hidden p-0">
              <div className="flex items-center gap-2.5 bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
                <Table2 size={16} className="shrink-0 text-amber-500" />
                <span className="text-sm font-medium">{t('concept_mapping.export_source_csv')}</span>
                <Badge variant="outline" className="ml-auto text-[10px]">.csv</Badge>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">{t('concept_mapping.export_source_csv_db_desc')}</p>
              </div>
              <div className="px-4 pb-4">
                <Button
                  className="w-full"
                  variant="outline"
                  size="sm"
                  onClick={handleExportSourceDb}
                  disabled={sourceExporting}
                >
                  {sourceExporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  {t('concept_mapping.export_download')}
                </Button>
              </div>
            </Card>
          )}
        </div>

        {/* Empty state */}
        {mappings.length === 0 && (
          <Card>
            <div className="flex flex-col items-center py-10">
              <Download size={32} className="text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">
                {t('concept_mapping.export_empty')}
              </p>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
