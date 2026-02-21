import { useState, useMemo, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Upload, FileCode, Loader2, AlertCircle, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEtlStore } from '@/stores/etl-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { schemaName } from '@/lib/duckdb/engine'
import { buildVocabularyScript } from './build-vocabulary-script'
import type { ConceptMapping, EtlFile, MappingStatus } from '@/types'

const VOCAB_SCRIPT_NAME = '00_vocabulary.sql'

type ApprovalRule = 'at_least_one' | 'majority' | 'no_rejections'

const STATUSES: MappingStatus[] = ['approved', 'rejected', 'flagged', 'unchecked']

interface Props {
  pipelineId: string
}

/**
 * Parse a CSV string into rows matching source_to_concept_map columns.
 */
function parseCsv(csv: string): ConceptMapping[] {
  const lines = csv.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase())
  const sourceCodeIdx = header.indexOf('source_code')
  const sourceConceptIdIdx = header.indexOf('source_concept_id')
  const sourceVocabIdx = header.indexOf('source_vocabulary_id')
  const sourceDescIdx = header.indexOf('source_code_description')
  const targetConceptIdIdx = header.indexOf('target_concept_id')
  const targetVocabIdx = header.indexOf('target_vocabulary_id')

  if (sourceCodeIdx < 0 || targetConceptIdIdx < 0) return []

  return lines.slice(1).map((line, i) => {
    const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    return {
      id: `csv-import-${i}`,
      projectId: '',
      sourceConceptId: Number(cols[sourceConceptIdIdx]) || 0,
      sourceConceptName: cols[sourceDescIdx] ?? '',
      sourceVocabularyId: cols[sourceVocabIdx] ?? '',
      sourceDomainId: '',
      sourceConceptCode: cols[sourceCodeIdx] ?? '',
      targetConceptId: Number(cols[targetConceptIdIdx]) || 0,
      targetConceptName: '',
      targetVocabularyId: cols[targetVocabIdx] ?? '',
      targetDomainId: '',
      targetConceptCode: '',
      mappingType: 'maps_to' as const,
      equivalence: 'skos:exactMatch' as const,
      status: 'approved' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  })
}

/**
 * Create or update the vocabulary pipeline script with the given SQL content.
 * Always placed at order -1 so it appears first (before user scripts starting at 0+).
 */
async function upsertVocabScript(pipelineId: string, sql: string): Promise<'created' | 'updated'> {
  const { files, createFile, updateFile } = useEtlStore.getState()
  const existing = files.find((f) => f.name === VOCAB_SCRIPT_NAME && f.pipelineId === pipelineId)

  if (existing) {
    await updateFile(existing.id, { content: sql })
    return 'updated'
  } else {
    const file: EtlFile = {
      id: crypto.randomUUID(),
      pipelineId,
      name: VOCAB_SCRIPT_NAME,
      type: 'file',
      parentId: null,
      content: sql,
      language: 'sql',
      order: -1,
      createdAt: new Date().toISOString(),
    }
    await createFile(file)
    return 'created'
  }
}

/**
 * Filter mappings by status checkboxes + approval sub-rules (same logic as ExportTab).
 */
function filterMappings(
  mappings: ConceptMapping[],
  includedStatuses: Set<MappingStatus>,
  approvalRule: ApprovalRule,
): ConceptMapping[] {
  let result = mappings.filter((m) => includedStatuses.has(m.status))

  if (includedStatuses.has('approved') && approvalRule !== 'at_least_one') {
    const sourceConceptStatuses = new Map<number, MappingStatus[]>()
    for (const m of mappings) {
      const arr = sourceConceptStatuses.get(m.sourceConceptId) ?? []
      arr.push(m.status)
      sourceConceptStatuses.set(m.sourceConceptId, arr)
    }

    result = result.filter((m) => {
      if (m.status !== 'approved') return true
      const statuses = sourceConceptStatuses.get(m.sourceConceptId) ?? []
      const approvedCount = statuses.filter((s) => s === 'approved').length
      const rejectedCount = statuses.filter((s) => s === 'rejected').length

      if (approvalRule === 'majority') return approvedCount > rejectedCount
      if (approvalRule === 'no_rejections') return rejectedCount === 0
      return true
    })
  }

  return result
}

export function EtlVocabularyTab({ pipelineId }: Props) {
  const { t } = useTranslation()
  const { etlPipelines, updatePipeline } = useEtlStore()
  const { mappingProjects, mappingProjectsLoaded, loadMappingProjects, loadProjectMappings, mappings } = useConceptMappingStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const pipeline = etlPipelines.find((p) => p.id === pipelineId)

  // Ensure mapping projects are loaded
  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
  }, [mappingProjectsLoaded, loadMappingProjects])

  // Use the persisted mappingProjectId from the pipeline, or default to first available
  const [selectedProjectId, setSelectedProjectId] = useState<string>(pipeline?.mappingProjectId ?? '')

  // Auto-select default when projects load and none is set
  const workspaceId = pipeline?.workspaceId
  const availableProjects = mappingProjects.filter((p) => !workspaceId || p.workspaceId === workspaceId)
  useEffect(() => {
    if (!selectedProjectId && availableProjects.length > 0) {
      const defaultId = availableProjects[0].id
      setSelectedProjectId(defaultId)
      if (pipeline) updatePipeline(pipeline.id, { mappingProjectId: defaultId })
    }
  }, [selectedProjectId, availableProjects, pipeline, updatePipeline])

  // Persist selection changes
  const handleProjectChange = useCallback((id: string) => {
    setSelectedProjectId(id)
    if (pipeline) updatePipeline(pipeline.id, { mappingProjectId: id || undefined })
  }, [pipeline, updatePipeline])
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState<{ success: boolean; count: number; action?: 'created' | 'updated'; error?: string } | null>(null)

  // Status filter state (same pattern as ExportTab)
  const [includedStatuses, setIncludedStatuses] = useState<Set<MappingStatus>>(new Set(['approved']))
  const [approvalRule, setApprovalRule] = useState<ApprovalRule>('at_least_one')

  const toggleStatus = (status: MappingStatus) => {
    setIncludedStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  // Load mappings when a project is selected
  useEffect(() => {
    if (selectedProjectId) loadProjectMappings(selectedProjectId)
  }, [selectedProjectId, loadProjectMappings])

  // Mappings for the selected project
  const projectMappings = useMemo(
    () => mappings.filter((m) => m.projectId === selectedProjectId),
    [mappings, selectedProjectId],
  )

  // Status counts
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const m of projectMappings) {
      counts[m.status] = (counts[m.status] ?? 0) + 1
    }
    return counts
  }, [projectMappings])

  // Filtered mappings
  const filteredMappings = useMemo(
    () => filterMappings(projectMappings, includedStatuses, approvalRule),
    [projectMappings, includedStatuses, approvalRule],
  )

  // Resolve vocabulary data source schema for the selected mapping project
  const vocabSchema = useMemo(() => {
    const project = mappingProjects.find((p) => p.id === selectedProjectId)
    const vocabDsId = project?.vocabularyDataSourceId
    if (!vocabDsId) return null
    const vocabDs = dataSources.find((ds) => ds.id === vocabDsId)
    if (!vocabDs) return null
    return schemaName(vocabDsId)
  }, [selectedProjectId, mappingProjects, dataSources])

  const handleCreateFromProject = useCallback(async () => {
    if (!selectedProjectId || filteredMappings.length === 0) return
    if (!vocabSchema) {
      setResult({ success: false, count: 0, error: t('etl.vocab_no_vocab_ds') })
      return
    }
    setCreating(true)
    setResult(null)

    try {
      const sql = buildVocabularyScript(filteredMappings, vocabSchema)
      const action = await upsertVocabScript(pipelineId, sql)
      setResult({ success: true, count: filteredMappings.length, action })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setResult({ success: false, count: 0, error: msg })
    } finally {
      setCreating(false)
    }
  }, [selectedProjectId, filteredMappings, pipelineId, vocabSchema, t])

  const handleCreateFromFile = useCallback(async () => {
    if (!vocabSchema) {
      setResult({ success: false, count: 0, error: t('etl.vocab_no_vocab_ds') })
      return
    }

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return

      setCreating(true)
      setResult(null)

      try {
        const text = await file.text()
        const parsed = parseCsv(text)

        if (parsed.length === 0) {
          setResult({ success: false, count: 0, error: t('etl.vocab_invalid_csv') })
          return
        }

        const sql = buildVocabularyScript(parsed, vocabSchema)
        const action = await upsertVocabScript(pipelineId, sql)
        setResult({ success: true, count: parsed.length, action })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setResult({ success: false, count: 0, error: msg })
      } finally {
        setCreating(false)
      }
    }
    input.click()
  }, [pipelineId, vocabSchema, t])

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 overflow-auto p-8">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <BookOpen size={32} className="mx-auto mb-2 text-muted-foreground" />
          <h3 className="text-sm font-medium">{t('etl.vocab_title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('etl.vocab_description')}
          </p>
        </div>

        {/* Warning if no vocabulary data source */}
        {selectedProjectId && !vocabSchema && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <span className="flex items-center gap-1.5">
              <AlertCircle size={14} />
              {t('etl.vocab_no_vocab_ds')}
            </span>
          </div>
        )}

        {/* Option 1: From mapping project */}
        <div className="space-y-2">
          <Label className="text-xs font-medium">{t('etl.vocab_from_project')}</Label>
          <Select value={selectedProjectId} onValueChange={handleProjectChange}>
            <SelectTrigger className="text-xs">
              <SelectValue placeholder={t('etl.vocab_select_project')} />
            </SelectTrigger>
            <SelectContent>
              {availableProjects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Status filter (shown when a project is selected) */}
          {selectedProjectId && projectMappings.length > 0 && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-medium">{t('concept_mapping.export_filter_title')}</p>
              <div className="space-y-1.5">
                {STATUSES.map((status) => {
                  const count = statusCounts[status] ?? 0
                  const checked = includedStatuses.has(status)
                  return (
                    <div key={status}>
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleStatus(status)}
                          className="size-3.5 rounded border-gray-300 accent-primary"
                        />
                        <span className="text-xs">{t(`concept_mapping.status_${status}`)}</span>
                        <Badge variant="secondary" className="text-[10px]">{count}</Badge>
                      </label>

                      {/* Approval sub-rules */}
                      {status === 'approved' && checked && (
                        <div className="ml-6 mt-1 space-y-1">
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
              <div className="border-t pt-2">
                <p className="text-[11px] text-muted-foreground">
                  {t('concept_mapping.export_total')}: <strong>{filteredMappings.length}</strong> {t('concept_mapping.export_mappings_count')}
                </p>
              </div>
            </div>
          )}

          <Button
            size="sm"
            className="w-full"
            onClick={handleCreateFromProject}
            disabled={!selectedProjectId || filteredMappings.length === 0 || !vocabSchema || creating}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <FileCode size={14} />}
            {t('etl.vocab_create_script')}
          </Button>
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[10px] uppercase text-muted-foreground">{t('etl.vocab_or')}</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        {/* Option 2: From CSV file */}
        <div className="space-y-2">
          <Label className="text-xs font-medium">{t('etl.vocab_from_file')}</Label>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleCreateFromFile}
            disabled={!vocabSchema || creating}
          >
            <Upload size={14} />
            {t('etl.vocab_upload_csv')}
          </Button>
          <p className="text-[10px] text-muted-foreground">{t('etl.vocab_csv_hint')}</p>
        </div>

        {/* Result */}
        {result && (
          <div className={`rounded-md border p-3 text-xs ${
            result.success
              ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200'
              : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200'
          }`}>
            {result.success ? (
              <span className="flex items-center gap-1.5">
                <Check size={14} />
                {t(result.action === 'updated' ? 'etl.vocab_script_updated' : 'etl.vocab_script_created', { count: result.count })}
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <AlertCircle size={14} />
                {result.error || t('etl.vocab_import_error')}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
