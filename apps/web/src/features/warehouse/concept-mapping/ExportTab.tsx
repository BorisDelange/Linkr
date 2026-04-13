import { useState, useMemo, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileText, FileSpreadsheet, FileCode, Loader2, Archive, AlertTriangle } from 'lucide-react'
import JSZip from 'jszip'
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
  exportUnmappedToStcm,
  downloadFile,
  buildMappingProjectFolder,
} from '@/lib/concept-mapping/export'
import { downloadBlob, slugify, timestamp } from '@/lib/entity-io'
import { buildSourceConceptsAllQuery, buildSourceConceptsCountQuery } from '@/lib/concept-mapping/mapping-queries'
import { getStorage } from '@/lib/storage'
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
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const [zipExporting, setZipExporting] = useState(false)
  const [sourceCsvTooLarge, setSourceCsvTooLarge] = useState(false)

  // Status checkboxes (approved checked by default)
  const [includedStatuses, setIncludedStatuses] = useState<Set<MappingStatus>>(
    new Set(['approved']),
  )
  const [approvalRule, setApprovalRule] = useState<ApprovalRule>('at_least_one')
  const [includeUnmapped, setIncludeUnmapped] = useState(false)
  const [totalSourceConcepts, setTotalSourceConcepts] = useState<number | null>(null)

  useEffect(() => {
    if (project.sourceType === 'file') {
      setTotalSourceConcepts(project.fileSourceData?.totalRowCount ?? project.fileSourceData?.rows.length ?? 0)
      return
    }
    if (!dataSource?.id || !dataSource.schemaMapping) return
    let cancelled = false
    const load = async () => {
      try {
        await ensureMounted(dataSource.id)
        const sql = buildSourceConceptsCountQuery(dataSource.schemaMapping!, {})
        if (!sql) return
        const [row] = await queryDataSource(dataSource.id, sql)
        if (!cancelled) setTotalSourceConcepts(Number(row?.total ?? 0))
      } catch { /* silently fail */ }
    }
    load()
    return () => { cancelled = true }
  }, [project.sourceType, project.fileSourceData, dataSource?.id, dataSource?.schemaMapping, ensureMounted])

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
        const mappedCsv = exportToSourceToConceptMap(filteredMappings, project, registryEntries)
        if (!includeUnmapped) return mappedCsv

        // Build set of already-mapped (vocabularyId, conceptCode) keys
        const mappedKeys = new Set(filteredMappings.map((m) => `${m.sourceVocabularyId}__${m.sourceConceptCode}`))

        // Collect ALL source concepts for this project
        let allSourceConcepts: { vocabularyId: string; conceptCode: string; conceptName: string }[] = []
        if (project.sourceType === 'file') {
          const rows = project.fileSourceData?.rows ?? []
          const colMapping = project.fileSourceData?.columnMapping
          const codeCol = colMapping?.conceptCodeColumn
          const vocabCol = colMapping?.terminologyColumn
          const nameCol = colMapping?.conceptNameColumn
          for (const row of rows) {
            const code = codeCol ? String(row[codeCol] ?? '') : ''
            const vocab = vocabCol ? String(row[vocabCol] ?? '') : project.name
            const name = nameCol ? String(row[nameCol] ?? '') : code
            if (code) allSourceConcepts.push({ vocabularyId: vocab, conceptCode: code, conceptName: name })
          }
        } else if (dataSource?.schemaMapping) {
          try {
            await ensureMounted(dataSource.id)
            const sql = buildSourceConceptsAllQuery(dataSource.schemaMapping, {})
            if (sql) {
              const rows = await queryDataSource(dataSource.id, sql)
              allSourceConcepts = rows.map((r) => ({
                vocabularyId: String(r.vocabulary_id ?? dataSource.id),
                conceptCode: String(r.concept_code ?? ''),
                conceptName: String(r.concept_name ?? ''),
              })).filter((c) => c.conceptCode)
            }
          } catch { /* skip if unavailable */ }
        }

        const unmappedCsv = exportUnmappedToStcm(allSourceConcepts, mappedKeys, registryEntries)
        if (!mappedCsv) return unmappedCsv
        if (!unmappedCsv) return mappedCsv
        // Both have a header line — strip the header from unmapped and append
        const unmappedRows = unmappedCsv.split('\n').slice(1).join('\n')
        return unmappedRows ? `${mappedCsv}\n${unmappedRows}` : mappedCsv
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
  ]

  const handleDownload = async (format: (typeof formats)[number]) => {
    const content = await format.generate()
    const filename = `${slug}-${format.id}.${format.ext}`
    downloadFile(content, filename, format.mime)
  }

  const handleExportZip = useCallback(async () => {
    setZipExporting(true)
    setSourceCsvTooLarge(false)
    try {
      const zip = new JSZip()
      await buildMappingProjectFolder(zip, '', project, getStorage(), {
        queryDataSource,
        ensureMounted,
        dataSources,
      })
      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(blob, `${slugify(project.name)}-${timestamp()}.zip`)
    } catch {
      // ZIP generation failed (likely memory overflow on very large source CSV)
      // Fall back: download ZIP without source CSV + source CSV separately
      try {
        const zip = new JSZip()
        await buildMappingProjectFolder(zip, '', project, getStorage(), {
          queryDataSource,
          ensureMounted,
          dataSources,
          skipSourceConcepts: true,
        })
        const blob = await zip.generateAsync({ type: 'blob' })
        downloadBlob(blob, `${slugify(project.name)}-${timestamp()}.zip`)

        if (project.sourceType === 'file' && project.fileSourceData?.rawFileBuffer?.byteLength) {
          try {
            const buf = project.fileSourceData.rawFileBuffer instanceof Uint8Array
              ? project.fileSourceData.rawFileBuffer
              : new Uint8Array(project.fileSourceData.rawFileBuffer)
            const csvBlob = new Blob([buf], { type: 'text/csv' })
            downloadBlob(csvBlob, `${slugify(project.name)}-source-concepts.csv`)
          } catch {
            setSourceCsvTooLarge(true)
          }
        } else {
          setSourceCsvTooLarge(true)
        }
      } catch {
        setSourceCsvTooLarge(true)
      }
    } finally {
      setZipExporting(false)
    }
  }, [project, dataSources, ensureMounted])

  const mappedSourceIds = useMemo(() => new Set(mappings.map((m) => `${m.sourceVocabularyId}__${m.sourceConceptCode}`)), [mappings])
  const unmappedCount = totalSourceConcepts !== null ? Math.max(0, totalSourceConcepts - mappedSourceIds.size) : null
  const totalExportCount = filteredMappings.length + (includeUnmapped && unmappedCount !== null ? unmappedCount : 0)

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Status filter section */}
        <Card className="p-4">
          <p className="mb-1.5 text-sm font-medium">{t('concept_mapping.export_filter_title')}</p>

          {/* Status checkboxes */}
          <div className="space-y-1">
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

            {/* Unmapped (STCM only) */}
            <div>
              <label className="flex cursor-pointer items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={includeUnmapped}
                  onChange={() => setIncludeUnmapped((v) => !v)}
                  className="size-3.5 rounded border-gray-300 accent-primary"
                />
                <span className="text-xs">{t('concept_mapping.export_unmapped')}</span>
                {unmappedCount !== null && unmappedCount > 0 && (
                  <Badge variant="secondary" className="text-[10px]">{unmappedCount}</Badge>
                )}
                <span className="text-[10px] text-muted-foreground">{t('concept_mapping.export_unmapped_stcm_only')}</span>
              </label>
            </div>
          </div>

          <div className="mt-1.5 border-t pt-1.5">
            <p className="text-xs text-muted-foreground">
              {t('concept_mapping.export_total')}: <strong>{totalExportCount}</strong> {t('concept_mapping.export_mappings_count')}
            </p>
          </div>
        </Card>

        {/* Format cards */}
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Linkr ZIP export — first position */}
          <Card className="flex flex-col justify-between overflow-hidden p-0">
            <div className="flex items-center gap-2.5 bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
              <Archive size={16} className="shrink-0 text-amber-500" />
              <span className="text-sm font-medium">{t('concept_mapping.export_linkr_zip')}</span>
              <Badge variant="outline" className="ml-auto text-[10px]">.zip</Badge>
            </div>
            <div className="px-4 py-3">
              <p className="text-xs text-muted-foreground">{t('concept_mapping.export_linkr_zip_desc')}</p>
            </div>
            <div className="space-y-2 px-4 pb-4">
              <Button
                className="w-full"
                variant="outline"
                size="sm"
                onClick={() => { setSourceCsvTooLarge(false); handleExportZip() }}
                disabled={zipExporting}
              >
                {zipExporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {t('concept_mapping.export_download')}
              </Button>
              {sourceCsvTooLarge && (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />
                  <p className="text-[11px] text-amber-700 dark:text-amber-300">
                    {t('concept_mapping.source_csv_too_large')}
                  </p>
                </div>
              )}
            </div>
          </Card>

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
        </div>
      </div>
    </div>
  )
}
