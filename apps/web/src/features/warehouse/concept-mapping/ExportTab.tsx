import { useState, useMemo, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileText, FileCode, Loader2, Archive, AlertTriangle } from 'lucide-react'
import JSZip from 'jszip'
import { ENTITY_MANIFEST } from '@linkr/format'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { DialogShell } from '@/components/ui/dialog-shell'
import { getScoresFile } from '@/lib/concept-mapping/scores-storage'
import { isServerMode } from '@/lib/api-client'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { queryDataSource, queryDataSourceAll, fileSourceDataSourceId, isFileSourceMounted, mountFileSourceIntoDuckDB } from '@/lib/duckdb/engine'
import {
  exportToUsagiCsv,
  exportToSourceToConceptMap,
  exportToSssomTsv,
  exportToConceptAndRelationship,
  exportUnmappedToStcm,
  exportUnmappedToUsagi,
  exportUnmappedToSssom,
  exportUnmappedToConcept,
  downloadFile,
  buildMappingProjectFolder,
} from '@/lib/concept-mapping/export'
import {
  OHDSI_FORMATS,
  OHDSI_FORMAT_SPECS,
  DEFAULT_OHDSI_FORMAT,
  ohdsiExt,
  zipCcrFiles,
  type OhdsiFormat,
} from '@/lib/concept-mapping/export-formats'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { downloadBlob, slugify, attachEntityOrganization } from '@/lib/entity-io'
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
  // Id of the format currently generating (SSSOM/STCM/Usagi) — drives its button spinner.
  const [downloadingFormat, setDownloadingFormat] = useState<string | null>(null)
  const [sourceCsvTooLarge, setSourceCsvTooLarge] = useState(false)

  // Which OHDSI vocabulary format the widget's picker is on.
  const [ohdsiFormat, setOhdsiFormat] = useState<OhdsiFormat>(DEFAULT_OHDSI_FORMAT)

  // Linkr ZIP export modal: lets the user opt into bundling the (large) scores parquet.
  const [zipDialogOpen, setZipDialogOpen] = useState(false)
  const [includeScores, setIncludeScores] = useState(false)
  const [scoresSize, setScoresSize] = useState<number | null>(null)

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

  const selectAllOptions = () => {
    setIncludedStatuses(new Set(STATUSES))
    setIncludeAllSourceConcepts(true)
  }
  const selectNoneOptions = () => {
    setIncludedStatuses(new Set())
    setIncludeAllSourceConcepts(false)
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
        // queryDataSourceAll (not queryDataSource): server mode caps a single
        // response at MAX_QUERY_ROWS (~10k), silently truncating large source
        // concept sets in the export. Page through to get every row.
        const rows = await queryDataSourceAll(dsId, 'SELECT vocabulary_id, concept_code, concept_name FROM source_concepts')
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
          const rows = await queryDataSourceAll(dataSource.id, sql)
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
  ]

  /**
   * Registry entries for this project's badges, which resolve the source concept
   * id when the project has no usable one of its own.
   */
  const loadRegistryEntries = useCallback(async () => {
    const badgeLabels = (project.badges ?? []).map((b) => localized(b.label, 'en')).filter(Boolean)
    if (badgeLabels.length === 0 || !project.workspaceId) return undefined
    const allEntries = await Promise.all(
      badgeLabels.map((label) => getStorage().sourceConceptIdEntries.getByWorkspaceAndBadge(project.workspaceId, label)),
    )
    const flat = allEntries.flat()
    return flat.length > 0 ? flat : undefined
  }, [project.badges, project.workspaceId])

  /** Build the selected OHDSI format — a string, or a blob for the C/CR ZIP. */
  const generateOhdsi = useCallback(async (format: OhdsiFormat): Promise<string | Blob> => {
    const registryEntries = await loadRegistryEntries()

    if (format === 'usagi') {
      return withSourceOnlyRows(
        exportToUsagiCsv(filteredMappings),
        (concepts, excludeKeys) => exportUnmappedToUsagi(concepts, excludeKeys),
      )
    }

    if (format === 'stcm') {
      return withSourceOnlyRows(
        exportToSourceToConceptMap(filteredMappings, project, registryEntries),
        (concepts, excludeKeys) => exportUnmappedToStcm(concepts, excludeKeys, registryEntries),
        true, // the STCM extra block has its own header line
      )
    }

    // C/CR: unmapped source concepts join concept.csv with no relationship —
    // a code with no 'Maps to' is exactly that in OMOP v5.
    const { conceptCsv, conceptRelationshipCsv } =
      exportToConceptAndRelationship(filteredMappings, project, registryEntries)
    const withUnmapped = await withSourceOnlyRows(
      conceptCsv,
      (concepts, excludeKeys) => exportUnmappedToConcept(concepts, excludeKeys, registryEntries),
    )
    return zipCcrFiles(withUnmapped, conceptRelationshipCsv)
  }, [filteredMappings, project, loadRegistryEntries, withSourceOnlyRows])

  const handleDownload = async (format: (typeof formats)[number]) => {
    // Generation can fetch source concepts from the server (slow); show a spinner
    // on this format's button, like the Linkr ZIP export.
    setDownloadingFormat(format.id)
    try {
      const content = await format.generate()
      const filename = `${slug}-${format.id}.${format.ext}`
      downloadFile(content, filename, format.mime)
    } finally {
      setDownloadingFormat(null)
    }
  }

  const handleOhdsiDownload = async () => {
    setDownloadingFormat('ohdsi')
    try {
      const spec = OHDSI_FORMAT_SPECS[ohdsiFormat]
      const content = await generateOhdsi(ohdsiFormat)
      const filename = `${slug}-${spec.file}`
      // C/CR comes back as a ZIP blob; the single-file formats as text.
      if (content instanceof Blob) downloadBlob(content, filename)
      else downloadFile(content, filename, spec.mime)
    } finally {
      setDownloadingFormat(null)
    }
  }

  const handleExportZip = useCallback(async (withScores: boolean) => {
    setZipExporting(true)
    setSourceCsvTooLarge(false)
    try {
      // Server mode without scores: let the backend assemble the git-variant ZIP
      // (offloads the browser — no data pulled down just to re-zip). Scores aren't
      // versioned, so a with-scores export still uses the client path below.
      if (isServerMode() && !withScores) {
        const { fetchExportZipFromServer } = await import('@/lib/api/mapping-projects')
        const blob = await fetchExportZipFromServer(project.id)
        if (blob) {
          downloadBlob(blob, `${slugify(localized(project.name, 'en'))}.zip`)
          return
        }
        // Fall through to the client build if the server couldn't produce it.
      }
      const zip = new JSZip()
      await buildMappingProjectFolder(zip, '', project, getStorage(), {
        queryDataSource: queryDataSourceAll,
        ensureMounted,
        dataSources,
        includeScores: withScores,
      })
      await attachEntityOrganization(zip, ENTITY_MANIFEST, project, getStorage())
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
          includeScores: withScores,
          skipSourceConcepts: true,
        })
        await attachEntityOrganization(zip, ENTITY_MANIFEST, project, getStorage())
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

  // Probe the stored scores file size, then open the export options modal.
  const openZipDialog = useCallback(async () => {
    setSourceCsvTooLarge(false)
    setIncludeScores(false)
    setScoresSize(null)
    setZipDialogOpen(true)
    try {
      if (isServerMode()) {
        const { fetchScoresFileSizeFromServer } = await import('@/lib/api/scores')
        setScoresSize(await fetchScoresFileSizeFromServer(project.id))
      } else {
        const f = await getScoresFile(project.id)
        setScoresSize(f ? f.size : 0)
      }
    } catch {
      setScoresSize(0)
    }
  }, [project.id])

  const confirmZipExport = useCallback(async () => {
    setZipDialogOpen(false)
    await handleExportZip(includeScores)
  }, [handleExportZip, includeScores])

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
        {/* Status filter section — two columns: statuses (left) / source-concept option + total (right) */}
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">{t('concept_mapping.export_filter_title')}</p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={selectAllOptions}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                {t('common.select_all')}
              </button>
              <span className="text-[10px] text-muted-foreground">/</span>
              <button
                type="button"
                onClick={selectNoneOptions}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                {t('common.select_none')}
              </button>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 sm:divide-x">
            {/* Left: status checkboxes */}
            <div>
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
                          className="size-3.5 rounded border-border accent-primary"
                        />
                        <span className="text-xs">{t(`concept_mapping.status_${status}`)}</span>
                        <Badge variant="secondary" >{count}</Badge>
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
            </div>

            {/* Right: include-all-source-concepts toggle + total */}
            <div className="flex flex-col sm:pl-4">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={includeAllSourceConcepts}
                  onChange={() => setIncludeAllSourceConcepts((v) => !v)}
                  className="mt-0.5 size-3.5 rounded border-border accent-primary"
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs">{t('concept_mapping.export_include_all_source_concepts')}</span>
                    {allSourceExtraCount !== null && allSourceExtraCount > 0 && (
                      <Badge variant="secondary" >{allSourceExtraCount}</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">{t('concept_mapping.export_include_all_source_concepts_desc')}</p>
                </div>
              </label>

              <div className="mt-auto border-t pt-2">
                <p className="text-xs text-muted-foreground">
                  {t('concept_mapping.export_total')}: <strong>{totalExportCount}</strong> {t('concept_mapping.export_mappings_count')}
                </p>
              </div>
            </div>
          </div>
        </Card>

        {/* Format cards */}
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Linkr ZIP export — first position */}
          <Card className="flex flex-col justify-between overflow-hidden p-0">
            <div className="flex items-center gap-2.5 bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
              <Archive size={16} className="shrink-0 text-amber-500" />
              <span className="text-sm font-medium">{t('concept_mapping.export_linkr_zip')}</span>
              <Badge variant="outline" className="ml-auto">.zip</Badge>
            </div>
            <div className="px-4 py-3">
              <p className="text-xs text-muted-foreground">{t('concept_mapping.export_linkr_zip_desc')}</p>
            </div>
            <div className="space-y-2 px-4 pb-4">
              <Button
                className="w-full"
                variant="outline"
                size="sm"
                onClick={openZipDialog}
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
                <Badge variant="outline" className="ml-auto">.{format.ext}</Badge>
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
                  disabled={downloadingFormat !== null || (totalExportCount === 0 && !('alwaysEnabled' in format && format.alwaysEnabled))}
                >
                  {downloadingFormat === format.id ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  {t('concept_mapping.export_download')}
                </Button>
              </div>
            </Card>
          ))}

          {/* The OHDSI vocabulary formats, behind one picker: they describe the
              same alignments, so choosing between them is a format question, not
              three separate exports. SSSOM stays its own card — it is the
              mapping-commons interchange format, a different audience. */}
          <Card className="flex flex-col justify-between overflow-hidden p-0">
            <div className="flex items-center gap-2.5 bg-blue-50 px-4 py-3 dark:bg-blue-950/30">
              <FileText size={16} className="shrink-0 text-blue-500" />
              <span className="text-sm font-medium">{t('concept_mapping.export_ohdsi')}</span>
              <Badge variant="outline" className="ml-auto">
                {ohdsiExt(ohdsiFormat)}
              </Badge>
            </div>
            {/* The picker sits WITH the description rather than above the button,
                so the card's footer is a lone button like every other one and the
                grid rows line up. */}
            <div className="space-y-2 px-4 py-3">
              <Select value={ohdsiFormat} onValueChange={(v) => setOhdsiFormat(v as OhdsiFormat)}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OHDSI_FORMATS.map((f) => (
                    <SelectItem key={f} value={f}>{t(OHDSI_FORMAT_SPECS[f].labelKey)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t(`concept_mapping.export_${ohdsiFormat}_desc`)}
              </p>
            </div>
            <div className="px-4 pb-4">
              <Button
                className="w-full"
                variant="outline"
                size="sm"
                onClick={handleOhdsiDownload}
                disabled={downloadingFormat !== null || totalExportCount === 0}
              >
                {downloadingFormat === 'ohdsi' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {t('concept_mapping.export_download')}
              </Button>
            </div>
          </Card>
        </div>
      </div>

      {/* Linkr ZIP export options modal */}
      <DialogShell
        open={zipDialogOpen}
        onOpenChange={setZipDialogOpen}
        title={t('concept_mapping.export_linkr_zip')}
        description={t('concept_mapping.export_zip_modal_desc')}
        contentClassName="space-y-3"
        onConfirm={confirmZipExport}
        confirmLabel={
          <>
            {!zipExporting && <Download size={14} />}
            {t('concept_mapping.export_download')}
          </>
        }
        busy={zipExporting}
      >
            {/* Core files — always included */}
            <div className="flex items-start gap-2.5 rounded-md border bg-muted/30 p-2.5">
              <Archive size={15} className="mt-0.5 shrink-0 text-amber-500" />
              <div className="min-w-0">
                <p className="text-xs font-medium">{t('concept_mapping.export_zip_core_files')}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{t('concept_mapping.export_zip_core_files_desc')}</p>
              </div>
            </div>

            {/* Scores — opt-in */}
            <label className={`flex items-start gap-2.5 rounded-md border p-2.5 ${scoresSize ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
              <input
                type="checkbox"
                checked={includeScores}
                disabled={!scoresSize}
                onChange={() => setIncludeScores((v) => !v)}
                className="mt-0.5 size-3.5 rounded border-border accent-primary"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{t('concept_mapping.export_include_scores')}</span>
                  {scoresSize ? (
                    <Badge variant="secondary" >{(scoresSize / 1024 / 1024).toFixed(1)} MB</Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {scoresSize === null
                    ? t('concept_mapping.export_scores_probing')
                    : scoresSize
                      ? t('concept_mapping.export_include_scores_desc')
                      : t('concept_mapping.export_scores_none_hint')}
                </p>
              </div>
            </label>
      </DialogShell>
    </div>
  )
}
