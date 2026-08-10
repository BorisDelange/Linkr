import { useState, useMemo, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, FileCode, Loader2, AlertCircle, Check } from 'lucide-react'
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
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { schemaName } from '@/lib/duckdb/engine'
import { localized } from '@/lib/localized'
import { buildVocabularyScriptWithIds } from './build-vocabulary-script'
import { buildStcmCsv } from '@/lib/concept-mapping/stcm-export'
import { MAPPING_DIR, STCM_EXPORT } from '@/lib/duckdb/mapping-source'
import type { ConceptMapping, EtlFile, MappingStatus } from '@/types'

const VOCAB_SCRIPT_NAME = '00_vocabulary.sql'

type ApprovalRule = 'at_least_one' | 'majority' | 'no_rejections'

const STATUSES: MappingStatus[] = ['approved', 'rejected', 'flagged', 'unchecked']

interface Props {
  pipelineId: string
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
 * Write the STCM export the generated script reads, as `mapping/<name>.csv`
 * inside the pipeline.
 *
 * The rows are not in the script on purpose: a mapping project is often a
 * private dictionary, and the script is versioned. The file is regenerated with
 * the script so the two never disagree, and is gitignored by default (the
 * per-file versioning mark can re-include it).
 */
async function upsertMappingExport(
  pipelineId: string,
  name: string,
  csv: string,
): Promise<void> {
  const { files, createFile, updateFile } = useEtlStore.getState()
  const own = files.filter((f) => f.pipelineId === pipelineId)

  let folder = own.find((f) => f.type === 'folder' && f.name === MAPPING_DIR && !f.parentId)
  if (!folder) {
    folder = {
      id: crypto.randomUUID(),
      pipelineId,
      name: MAPPING_DIR,
      type: 'folder',
      parentId: null,
      // Before the scripts, which start at -1: the exports they read.
      order: -2,
      createdAt: new Date().toISOString(),
    }
    await createFile(folder)
  }

  const fileName = `${name}.csv`
  const existing = own.find((f) => f.parentId === folder.id && f.name === fileName)
  if (existing) {
    await updateFile(existing.id, { content: csv })
    return
  }
  await createFile({
    id: crypto.randomUUID(),
    pipelineId,
    name: fileName,
    type: 'file',
    parentId: folder.id,
    content: csv,
    order: 0,
    createdAt: new Date().toISOString(),
  })
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
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('etl:write')
  const { etlPipelines, updatePipeline } = useEtlStore()
  const { mappingProjects, mappingProjectsLoaded, loadMappingProjects, loadProjectMappings, mappings, updateMapping } = useConceptMappingStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const pipeline = etlPipelines.find((p) => p.id === pipelineId)

  // Ensure mapping projects are loaded
  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
  }, [mappingProjectsLoaded, loadMappingProjects])

  /**
   * The mapping project this pipeline is attached to — only ever what the user
   * chose, never a default.
   *
   * It used to auto-select the first available project AND persist it. A pipeline
   * imported from git then looked attached to an arbitrary dictionary it was never
   * mapped against: the generated `00_vocabulary.sql` ran, filled
   * source_to_concept_map from the wrong source, and the failure surfaced far
   * downstream. An empty picker is the honest state, and the banner below says what
   * to do about it.
   */
  const [selectedProjectId, setSelectedProjectId] = useState<string>(pipeline?.mappingProjectId ?? '')
  const workspaceId = pipeline?.workspaceId
  const availableProjects = mappingProjects.filter((p) => !workspaceId || p.workspaceId === workspaceId)

  // Adopt the pipeline's persisted choice once it loads (the pipeline may arrive
  // after the first render), but never invent one.
  useEffect(() => {
    if (pipeline?.mappingProjectId && !selectedProjectId) {
      setSelectedProjectId(pipeline.mappingProjectId)
    }
  }, [pipeline?.mappingProjectId, selectedProjectId])

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

  // Which tables the reference actually holds: an ATHENA import keeps only the
  // four the mapping UI needs, so the metadata parts must be skipped rather
  // than emitted and left to fail on a missing table.
  const vocabTables = useMemo(() => {
    const project = mappingProjects.find((p) => p.id === selectedProjectId)
    const vocabDs = dataSources.find((ds) => ds.id === project?.vocabularyDataSourceId)
    return vocabDs?.schemaMapping?.knownTables ?? undefined
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
      // The script says `vocab.` rather than the resolved schema, so it stays
      // valid after an export/reimport (resolved at run time).
      const { sql, idsToPersist } = buildVocabularyScriptWithIds(
        filteredMappings, undefined, vocabTables, projectMappings,
      )
      // Store the source-concept ids this run settled on, so the next generation
      // reuses them instead of allocating new ones. Done before writing the
      // script: if this fails, the script that would reference unsaved ids is
      // not created either.
      for (const [mappingId, sourceConceptId] of idsToPersist) {
        await updateMapping(mappingId, { sourceConceptId })
      }
      // The export carries the rows the script reads; write it first so the
      // script is never the newer of the two.
      const { csv } = buildStcmCsv(filteredMappings, projectMappings)
      await upsertMappingExport(pipelineId, STCM_EXPORT, csv)
      const action = await upsertVocabScript(pipelineId, sql)
      setResult({ success: true, count: filteredMappings.length, action })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setResult({ success: false, count: 0, error: msg })
    } finally {
      setCreating(false)
    }
  }, [selectedProjectId, filteredMappings, projectMappings, pipelineId, vocabSchema, vocabTables, updateMapping, t])

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

        {/* No dictionary attached: the generated 00_vocabulary.sql has nothing to
            fill source_to_concept_map from, so the script fails at RUN time with a
            SQL error that says nothing about the real cause. Say it here instead. */}
        {!selectedProjectId && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <span className="flex items-start gap-2">
              <AlertCircle size={16} className="mt-px shrink-0" />
              <span>
                {availableProjects.length > 0
                  ? t('etl.vocab_no_project_attached')
                  : t('etl.vocab_no_project_available')}
              </span>
            </span>
          </div>
        )}

        {/* Warning if no vocabulary data source */}
        {selectedProjectId && !vocabSchema && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <span className="flex items-start gap-2">
              <AlertCircle size={16} className="mt-px shrink-0" />
              <span>{t('etl.vocab_no_vocab_ds')}</span>
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
                  {localized(p.name, i18n.language)}
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
            disabled={!selectedProjectId || filteredMappings.length === 0 || !vocabSchema || creating || !canWrite}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <FileCode size={14} />}
            {t('etl.vocab_create_script')}
          </Button>
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
