import { useState, useMemo, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileText, FileSpreadsheet, FileCode, Loader2, Archive, AlertTriangle } from 'lucide-react'
import JSZip from 'jszip'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { queryDataSource, fileSourceDataSourceId, isFileSourceMounted, mountFileSourceIntoDuckDB } from '@/lib/duckdb/engine'
import {
  exportToUsagiCsv,
  exportToSourceToConceptMap,
  exportToSssomTsv,
  exportUnmappedToStcm,
  exportUnmappedToUsagi,
  exportUnmappedToSssom,
  downloadFile,
  buildMappingProjectFolder,
} from '@/lib/concept-mapping/export'
import { downloadBlob, slugify } from '@/lib/entity-io'
import { localized } from '@/lib/localized'
import { buildSourceConceptsAllQuery, buildSourceConceptsCountQuery } from '@/lib/concept-mapping/mapping-queries'
import { effectiveMappingStatus, sourceKey } from '@/lib/concept-mapping/mapping-status'
import { getStorage } from '@/lib/storage'
import type { MappingProject, EffectiveMappingStatus, DataSource } from '@/types'

interface ExportTabProps {
  project: MappingProject
  dataSource?: DataSource
}

type ApprovalRule = 'at_least_one' | 'majority' | 'no_rejections'

const STATUSES: EffectiveMappingStatus[] = ['approved', 'rejected', 'flagged', 'disputed', 'unchecked', 'ignored']

export function ExportTab({ project, dataSource }: ExportTabProps) {
  const { t } = useTranslation()
  const { mappings } = useConceptMappingStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const [zipExporting, setZipExporting] = useState(false)
  const [sourceCsvTooLarge, setSourceCsvTooLarge] = useState(false)

  // Status checkboxes (approved checked by default)
  const [includedStatuses, setIncludedStatuses] = useState<Set<EffectiveMappingStatus>>(
    new Set(['approved']),
  )
  const [approvalRule, setApprovalRule] = useState<ApprovalRule>('at_least_one')
  const [includeAllSourceConcepts, setIncludeAllSourceConcepts] = useState(false)
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

  const toggleStatus = (status: EffectiveMappingStatus) => {
    setIncludedStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  // Effective status per mapping (review-aware) — keeps Export, Mapping Editor, Progress in sync.
  const mappingsWithEffective = useMemo(
    () => mappings.map((m) => ({ mapping: m, effective: effectiveMappingStatus(m) })),
    [mappings],
  )

  // Count per effective status (so a single approving review moves the mapping out of "unchecked").
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const { effective } of mappingsWithEffective) {
      counts[effective] = (counts[effective] ?? 0) + 1
    }
    return counts
  }, [mappingsWithEffective])

  const filteredMappings = useMemo(() => {
    // First filter: status checkboxes (using effective status)
    let result = mappingsWithEffective.filter(({ effective }) => includedStatuses.has(effective)).map((x) => x.mapping)

    // Then apply approval sub-rule for approved mappings (compare reviews per source concept)
    if (includedStatuses.has('approved') && approvalRule !== 'at_least_one') {
      // Group all mappings by source concept to check cross-mapping vote tallies
      const sourceConceptVotes = new Map<string, { approved: number; rejected: number }>()
      for (const { mapping: m } of mappingsWithEffective) {
        const key = sourceKey(m)
        const tally = sourceConceptVotes.get(key) ?? { approved: 0, rejected: 0 }
        const reviews = m.reviews ?? []
        tally.approved += reviews.filter((r) => r.status === 'approved').length
        tally.rejected += reviews.filter((r) => r.status === 'rejected').length
        // Also factor the mapping's own status when no reviews
        if (reviews.length === 0) {
          if (m.status === 'approved') tally.approved += 1
          else if (m.status === 'rejected') tally.rejected += 1
        }
        sourceConceptVotes.set(key, tally)
      }

      result = result.filter((m) => {
        if (effectiveMappingStatus(m) !== 'approved') return true
        const tally = sourceConceptVotes.get(sourceKey(m)) ?? { approved: 0, rejected: 0 }
        if (approvalRule === 'majority') return tally.approved > tally.rejected
        if (approvalRule === 'no_rejections') return tally.rejected === 0
        return true
      })
    }

    return result
  }, [mappingsWithEffective, includedStatuses, approvalRule])

  const slug = localized(project.name, 'en').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  /** Load every source concept for this project.
   *  - File source: query DuckDB (rows[] is deprecated when rawFileBuffer is used).
   *    Falls back to in-memory rows for legacy projects without rawFileBuffer.
   *  - Database source: query the source table via DuckDB. */
  const loadAllSourceConcepts = useCallback(async (): Promise<{ vocabularyId: string; conceptCode: string; conceptName: string }[]> => {
    if (project.sourceType === 'file') {
      if (!project.fileSourceData) return []
      // Try DuckDB first (newer projects use rawFileBuffer + DuckDB-mounted source_concepts).
      try {
        if (!isFileSourceMounted(project.id)) {
          await mountFileSourceIntoDuckDB(
            project.id,
            project.fileSourceData.rows,
            project.fileSourceData.columnMapping,
            project.fileSourceData.rawFileBuffer,
          )
        }
        const dsId = fileSourceDataSourceId(project.id)
        const rows = await queryDataSource(dsId, 'SELECT vocabulary_id, concept_code, concept_name FROM source_concepts')
        const out = rows.map((r: Record<string, unknown>) => ({
          vocabularyId: String(r.vocabulary_id ?? localized(project.name, 'en')),
          conceptCode: String(r.concept_code ?? ''),
          conceptName: String(r.concept_name ?? ''),
        })).filter((c) => c.conceptCode)
        if (out.length > 0) return out
      } catch { /* fall through to legacy rows[] */ }

      // Legacy fallback: in-memory rows[] (older projects, no rawFileBuffer).
      const rows = project.fileSourceData.rows ?? []
      const colMapping = project.fileSourceData.columnMapping
      const codeCol = colMapping?.conceptCodeColumn
      const vocabCol = colMapping?.terminologyColumn
      const nameCol = colMapping?.conceptNameColumn
      const out: { vocabularyId: string; conceptCode: string; conceptName: string }[] = []
      for (const row of rows) {
        const code = codeCol ? String(row[codeCol] ?? '') : ''
        const vocab = vocabCol ? String(row[vocabCol] ?? '') : localized(project.name, 'en')
        const name = nameCol ? String(row[nameCol] ?? '') : code
        if (code) out.push({ vocabularyId: vocab, conceptCode: code, conceptName: name })
      }
      return out
    }
    if (dataSource?.schemaMapping) {
      try {
        await ensureMounted(dataSource.id)
        const sql = buildSourceConceptsAllQuery(dataSource.schemaMapping, {})
        if (sql) {
          const rows = await queryDataSource(dataSource.id, sql)
          return rows.map((r) => ({
            vocabularyId: String(r.vocabulary_id ?? dataSource.id),
            conceptCode: String(r.concept_code ?? ''),
            conceptName: String(r.concept_name ?? ''),
          })).filter((c) => c.conceptCode)
        }
      } catch { /* skip if unavailable */ }
    }
    return []
  }, [project, dataSource, ensureMounted])

  /** Build the set of (vocab, code) keys that should NOT be appended as source-only rows.
   *  Excludes any code already present in the filtered output. */
  const buildExcludeKeys = useCallback((): Set<string> => {
    return new Set(filteredMappings.map((m) => `${m.sourceVocabularyId}__${m.sourceConceptCode}`))
  }, [filteredMappings])

  /** Append extra rows produced by `appendFn` to `mappedContent`, separated by a newline. */
  const withSourceOnlyRows = useCallback(async (
    mappedContent: string,
    appendFn: (concepts: { vocabularyId: string; conceptCode: string; conceptName: string }[], excludeKeys: Set<string>) => string,
    extraIsCsvWithHeader = false,
  ): Promise<string> => {
    if (!includeAllSourceConcepts) return mappedContent
    const allSourceConcepts = await loadAllSourceConcepts()
    const excludeKeys = buildExcludeKeys()
    const extra = appendFn(allSourceConcepts, excludeKeys)
    if (!mappedContent) return extra
    if (!extra) return mappedContent
    // STCM extra has its own header line — strip it before appending.
    const extraBody = extraIsCsvWithHeader ? extra.split('\n').slice(1).join('\n') : extra
    return extraBody ? `${mappedContent}\n${extraBody}` : mappedContent
  }, [includeAllSourceConcepts, loadAllSourceConcepts, buildExcludeKeys])

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
      generate: async () => {
        const mappedTsv = exportToSssomTsv(filteredMappings, project)
        return withSourceOnlyRows(mappedTsv, (concepts, excludeKeys) => exportUnmappedToSssom(concepts, excludeKeys))
      },
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
        return withSourceOnlyRows(
          mappedCsv,
          (concepts, excludeKeys) => exportUnmappedToStcm(concepts, excludeKeys, registryEntries),
          true, // STCM extra block has its own header line
        )
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
      generate: async () => {
        const mappedCsv = exportToUsagiCsv(filteredMappings)
        return withSourceOnlyRows(mappedCsv, (concepts, excludeKeys) => exportUnmappedToUsagi(concepts, excludeKeys))
      },
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
      downloadBlob(blob, `${slugify(localized(project.name, 'en'))}.zip`)
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
        downloadBlob(blob, `${slugify(localized(project.name, 'en'))}.zip`)

        if (project.sourceType === 'file' && project.fileSourceData?.rawFileBuffer?.byteLength) {
          try {
            const buf = project.fileSourceData.rawFileBuffer instanceof Uint8Array
              ? project.fileSourceData.rawFileBuffer
              : new Uint8Array(project.fileSourceData.rawFileBuffer)
            // TS lib.dom's BlobPart rejects the generic Uint8Array<ArrayBufferLike>; runtime accepts it
            const csvBlob = new Blob([buf as BlobPart], { type: 'text/csv' })
            downloadBlob(csvBlob, `${slugify(localized(project.name, 'en'))}-source-concepts.csv`)
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

  // Dedup by (vocabularyId, conceptCode) — same key as Progress / Mapping Editor.
  const filteredMappedKeys = useMemo(() => new Set(filteredMappings.map(sourceKey)), [filteredMappings])
  // "Include all source concepts": adds the source concepts that are NOT covered by `filteredMappings`
  // (they may have non-matching mappings, or be entirely unmapped).
  const allSourceExtraCount = totalSourceConcepts !== null
    ? Math.max(0, totalSourceConcepts - filteredMappedKeys.size)
    : null
  const totalExportCount =
    filteredMappings.length
    + (includeAllSourceConcepts && allSourceExtraCount !== null ? allSourceExtraCount : 0)

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
          </div>

          {/* Include all source concepts (independent toggle) */}
          <div className="mt-3 border-t pt-2">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={includeAllSourceConcepts}
                onChange={() => setIncludeAllSourceConcepts((v) => !v)}
                className="mt-0.5 size-3.5 rounded border-gray-300 accent-primary"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs">{t('concept_mapping.export_include_all_source_concepts')}</span>
                  {allSourceExtraCount !== null && allSourceExtraCount > 0 && (
                    <Badge variant="secondary" className="text-[10px]">{allSourceExtraCount}</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{t('concept_mapping.export_include_all_source_concepts_desc')}</p>
              </div>
            </label>
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
