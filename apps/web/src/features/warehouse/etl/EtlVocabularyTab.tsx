import { useState, useMemo, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, FileCode, Loader2, AlertCircle, Check, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
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
import { buildVocabularyScriptWithIds, buildPruneVocabularyScript } from './build-vocabulary-script'
import { buildStcmCsv } from '@/lib/concept-mapping/stcm-export'
import { MAPPING_DIR, STCM_EXPORT, mappingExportPath } from '@/lib/duckdb/mapping-source'
import { vocabularyReadiness } from './vocabulary-readiness'
import type { ConceptMapping, EtlFile, EtlVocabularyConfig, MappingStatus } from '@/types'

const VOCAB_SCRIPT_NAME = '00_vocabulary.sql'
const PRUNE_SCRIPT_NAME = '99_prune_vocabulary.sql'

/**
 * Where each generated script sits in the run order.
 *
 * These two names are imposed on every pipeline, so they bracket the run and
 * leave the whole middle to the user. The vocabulary script fills the concept
 * tables, so it runs before everything (-1). The prune reads the CDM tables to
 * see which concepts were written, so it runs last (99): after the user's own
 * tests and provenance steps, and after any cleanup that drops staging tables
 * — a staging table left in place would be scanned for *_concept_id columns
 * and keep concepts alive that no CDM row references.
 */
const VOCAB_SCRIPT_ORDER = -1
const PRUNE_SCRIPT_ORDER = 99

type ApprovalRule = 'at_least_one' | 'majority' | 'no_rejections'

/** The artefacts the Vocabulary tab can write — see `generate` below. */
type Artefact = 'csv' | 'script' | 'prune'

const STATUSES: MappingStatus[] = ['approved', 'rejected', 'flagged', 'unchecked']

interface Props {
  pipelineId: string
}

/**
 * Create or update a generated pipeline script with the given SQL content.
 *
 * `order` decides where it sits in the run: the vocabulary script at -1 runs
 * before every user script (0+), while the prune script has to run after them —
 * it reads the CDM tables to find out which concepts were written.
 */
async function upsertGeneratedScript(
  pipelineId: string, name: string, sql: string, order: number,
): Promise<'created' | 'updated'> {
  const { files, createFile, updateFile } = useEtlStore.getState()
  const existing = files.find((f) => f.name === name && f.pipelineId === pipelineId)

  if (existing) {
    await updateFile(existing.id, { content: sql })
    return 'updated'
  } else {
    const file: EtlFile = {
      id: crypto.randomUUID(),
      pipelineId,
      name,
      type: 'file',
      parentId: null,
      content: sql,
      language: 'sql',
      order,
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
  const { etlPipelines, updatePipeline, files, filesLoaded, activePipelineId } = useEtlStore()
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
  const [result, setResult] = useState<{
    success: boolean
    count: number
    written?: Artefact[]
    error?: string
  } | null>(null)

  /**
   * The tab's choices live on the pipeline, not in component state: they say how
   * this pipeline's vocabulary is built, so losing them on a tab switch made the
   * status filter silently fall back to "approved only" and quietly change what
   * the next generation would contain.
   */
  const vocabConfig = pipeline?.config?.vocabulary
  const saveVocabConfig = useCallback((patch: Partial<EtlVocabularyConfig>) => {
    if (!pipeline) return
    updatePipeline(pipeline.id, {
      config: {
        ...pipeline.config,
        vocabulary: { ...pipeline.config?.vocabulary, ...patch },
      },
    })
  }, [pipeline, updatePipeline])

  const selected = useMemo(
    () => new Set<Artefact>((vocabConfig?.artefacts as Artefact[] | undefined)
      ?? ['csv', 'script', 'prune']),
    [vocabConfig?.artefacts],
  )
  /** Edited or up-to-date artefacts the user ticked back, accepting the rewrite. */
  const [overwrite, setOverwrite] = useState<Set<Artefact>>(new Set())

  const toggleArtefact = useCallback((a: Artefact, isOn: boolean) => {
    const next = new Set(selected)
    if (isOn) next.delete(a)
    else next.add(a)
    saveVocabConfig({ artefacts: [...next] })
    // Ticking an artefact that comes unticked is the explicit go-ahead to
    // rewrite it. Kept in memory: it answers "this time", not "from now on".
    setOverwrite((prev) => {
      const set = new Set(prev)
      if (isOn) set.delete(a)
      else set.add(a)
      return set
    })
  }, [selected, saveVocabConfig])

  // Status filter (same pattern as ExportTab), persisted alongside the rest.
  const includedStatuses = useMemo(
    () => new Set<MappingStatus>(vocabConfig?.statuses ?? ['approved']),
    [vocabConfig?.statuses],
  )
  const approvalRule: ApprovalRule = vocabConfig?.approvalRule ?? 'at_least_one'
  const setApprovalRule = useCallback(
    (rule: ApprovalRule) => saveVocabConfig({ approvalRule: rule }),
    [saveVocabConfig],
  )

  const toggleStatus = (status: MappingStatus) => {
    const next = new Set(includedStatuses)
    if (next.has(status)) next.delete(status)
    else next.add(status)
    saveVocabConfig({ statuses: [...next] })
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

  /**
   * Exports the pipeline's scripts read but do not have.
   *
   * A pipeline imported from git has `00_vocabulary.sql` but not
   * `mapping/source_to_concept_map.csv` — the export is gitignored, being derived
   * from a dictionary that is often private. Without this the first sign was a
   * DuckDB "file not found: mapping.source_to_concept_map" at run time.
   */
  const readiness = useMemo(() => {
    // Judged only once THIS pipeline's files are in: before that everything looks
    // missing, which would flash the banner on every open.
    if (!filesLoaded || activePipelineId !== pipelineId) {
      return { missingExports: [], emptyExports: [], usesExports: false, ready: true }
    }
    return vocabularyReadiness(files.filter((f) => f.pipelineId === pipelineId))
  }, [files, filesLoaded, activePipelineId, pipelineId])

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

  /**
   * Scripts already in the pipeline whose stored content differs from what
   * would be written now — usually a hand edit.
   *
   * Ticking them by default would silently overwrite that work, so they come
   * unticked and say why. Rebuilding them stays one click away.
   */
  /** Stored content of each artefact, or undefined when it is not there yet. */
  const storedArtefacts = useMemo(() => {
    const own = files.filter((f) => f.pipelineId === pipelineId)
    const atRoot = (name: string) =>
      own.find((f) => f.name === name && !f.parentId)?.content
    // The CSV sits in the mapping/ folder, so it is found by parent rather than
    // by name alone — looking it up like the scripts silently found nothing.
    const folder = own.find((f) => f.type === 'folder' && f.name === MAPPING_DIR && !f.parentId)
    return {
      csv: folder
        ? own.find((f) => f.parentId === folder.id && f.name === `${STCM_EXPORT}.csv`)?.content
        : undefined,
      script: atRoot(VOCAB_SCRIPT_NAME),
      prune: atRoot(PRUNE_SCRIPT_NAME),
    } satisfies Record<Artefact, string | undefined>
  }, [files, pipelineId])

  const editedScripts = useMemo(() => {
    const edited = new Set<Artefact>()

    if (storedArtefacts.prune !== undefined
      && storedArtefacts.prune !== buildPruneVocabularyScript()) {
      edited.add('prune')
    }

    // The other two are built from the mappings; with none selected there is
    // nothing to compare against, so leave those boxes alone.
    if (filteredMappings.length > 0) {
      if (storedArtefacts.csv !== undefined
        && storedArtefacts.csv !== buildStcmCsv(filteredMappings, projectMappings).csv) {
        edited.add('csv')
      }
      // The vocabulary script also needs the reference to be generated at all.
      if (storedArtefacts.script !== undefined && vocabSchema) {
        const { sql } = buildVocabularyScriptWithIds(
          filteredMappings, undefined, vocabTables, projectMappings,
        )
        if (storedArtefacts.script !== sql) edited.add('script')
      }
    }
    return edited
  }, [storedArtefacts, vocabSchema, filteredMappings, vocabTables, projectMappings])

  /**
   * Artefacts already in the pipeline with exactly the content that would be
   * written. Rewriting them is a no-op, so they come unticked.
   *
   * Only counts as up to date when a comparison actually ran: `editedScripts`
   * skips artefacts it cannot rebuild (no mappings selected, no vocabulary
   * reference), and treating "not compared" as "identical" would untick a box
   * that may well be stale.
   */
  const upToDateArtefacts = useMemo(() => {
    const fresh = new Set<Artefact>()
    const compared = (a: Artefact) =>
      a === 'prune' ? true
        : filteredMappings.length > 0 && (a === 'csv' || !!vocabSchema)
    for (const a of ['csv', 'script', 'prune'] as const) {
      if (storedArtefacts[a] !== undefined && compared(a) && !editedScripts.has(a)) fresh.add(a)
    }
    return fresh
  }, [storedArtefacts, editedScripts, filteredMappings, vocabSchema])

  /**
   * What actually gets written: artefacts already up to date, and edited ones
   * the user has not ticked back, are dropped.
   *
   * Derived rather than pushed into state by an effect — the comparison
   * recomputes whenever the stored files change, and an effect writing to
   * `selected` would fight that on every keystroke in the script editor.
   */
  const effectiveSelected = useMemo(() => {
    const next = new Set(selected)
    // Nothing to do for an artefact already holding that exact content, and
    // overwriting an edited one needs to be asked for. Both stay one tick away.
    for (const a of [...editedScripts, ...upToDateArtefacts]) {
      if (!overwrite.has(a)) next.delete(a)
    }
    return next
  }, [selected, editedScripts, upToDateArtefacts, overwrite])

  /**
   * Write the artefacts the checkboxes select.
   *
   * They are picked one by one because they have genuinely different lifetimes:
   * the scripts are versioned and may be hand-edited (and worth KEEPING), while
   * the CSV is gitignored derived data that has to be rebuilt on every clone.
   * Regenerating everything just to recover the CSV silently discarded those
   * edits — hence `scriptDiffers`, which unticks a script whose stored content
   * no longer matches what would be written.
   *
   * The artefacts stay consistent when written apart because the script and the
   * CSV both take their source-concept ids from `assignSourceConceptIds` over
   * the same project, which reuses the ids already stored on each mapping
   * rather than renumbering.
   */
  const generate = useCallback(async () => {
    if (!selectedProjectId || filteredMappings.length === 0 || effectiveSelected.size === 0) return
    // Only the vocabulary script reads the reference; the CSV is built purely
    // from the mappings and the prune script only reads the target, so both must
    // stay available when no ATHENA import exists.
    if (effectiveSelected.has('script') && !vocabSchema) {
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
      // reuses them instead of allocating new ones. Done before writing anything:
      // if it fails, no artefact references an unsaved id. Needed for the CSV
      // alone too — it carries the same ids.
      for (const [mappingId, sourceConceptId] of idsToPersist) {
        await updateMapping(mappingId, { sourceConceptId })
      }
      // The export carries the rows the script reads; write it first so the
      // script is never the newer of the two.
      if (effectiveSelected.has('csv')) {
        const { csv } = buildStcmCsv(filteredMappings, projectMappings)
        await upsertMappingExport(pipelineId, STCM_EXPORT, csv)
      }
      if (effectiveSelected.has('script')) {
        await upsertGeneratedScript(pipelineId, VOCAB_SCRIPT_NAME, sql, VOCAB_SCRIPT_ORDER)
      }
      if (effectiveSelected.has('prune')) {
        await upsertGeneratedScript(
          pipelineId, PRUNE_SCRIPT_NAME, buildPruneVocabularyScript(), PRUNE_SCRIPT_ORDER,
        )
      }
      setResult({ success: true, count: filteredMappings.length, written: [...effectiveSelected] })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setResult({ success: false, count: 0, error: msg })
    } finally {
      setCreating(false)
    }
  }, [selectedProjectId, filteredMappings, projectMappings, pipelineId, vocabSchema, vocabTables, effectiveSelected, updateMapping, t])

  // The CSV and the prune script need no vocabulary reference; only the
  // vocabulary script does, and it adds its own condition.
  const cannotGenerate = !selectedProjectId || filteredMappings.length === 0 || !canWrite

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

        {/* The scripts are here but the data they read is not: the CSV is
            gitignored, so it never survives a clone. Regenerating it is the fix,
            and it does not require touching the script. */}
        {!readiness.ready && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <span className="flex items-start gap-2">
              <AlertCircle size={16} className="mt-px shrink-0" />
              <span>
                {readiness.missingExports.length > 0
                  ? t('etl.vocab_export_missing', {
                      files: readiness.missingExports.map((n) => mappingExportPath(n)).join(', '),
                      count: readiness.missingExports.length,
                    })
                  : t('etl.vocab_export_empty', {
                      files: readiness.emptyExports.map((n) => mappingExportPath(n)).join(', '),
                      count: readiness.emptyExports.length,
                    })}
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

          {/* Pick the artefacts, write them in one go. They are separable
              because a hand-edited script is a versioned file worth keeping,
              while the CSV beside it is gitignored derived data rebuilt after
              every clone: regenerating everything to recover the CSV used to
              throw those edits away. */}
          <div className="space-y-2">
            <div className="space-y-1.5 rounded-md border p-2.5">
              {([
                { id: 'csv' as const, label: t('etl.vocab_artefact_csv'), hint: mappingExportPath(STCM_EXPORT), icon: Table2 },
                { id: 'script' as const, label: t('etl.vocab_artefact_script'), hint: VOCAB_SCRIPT_NAME, icon: FileCode },
                { id: 'prune' as const, label: t('etl.vocab_artefact_prune'), hint: PRUNE_SCRIPT_NAME, icon: FileCode },
              ]).map(({ id, label, hint, icon: Icon }) => (
                <label key={id} className="flex cursor-pointer items-start gap-2">
                  <Checkbox
                    checked={effectiveSelected.has(id)}
                    onCheckedChange={() => toggleArtefact(id, effectiveSelected.has(id))}
                    disabled={creating || (id === 'script' && !vocabSchema)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-xs">
                      <Icon size={12} className="shrink-0 text-muted-foreground" />
                      {label}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {hint}
                    </span>
                    {/* Three states worth telling apart: absent (nothing said),
                        present and identical, present and different. Only the
                        last one is a warning — the others just say where the
                        pipeline stands. */}
                    {editedScripts.has(id) ? (
                      <span className="block text-[10px] text-amber-600 dark:text-amber-500">
                        {t('etl.vocab_artefact_edited')}
                      </span>
                    ) : upToDateArtefacts.has(id) && (
                      <span className="block text-[10px] text-muted-foreground">
                        {t('etl.vocab_artefact_up_to_date')}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <Button
              size="sm"
              className="w-full"
              onClick={generate}
              disabled={cannotGenerate || creating || effectiveSelected.size === 0}
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : <FileCode size={14} />}
              {t('etl.vocab_create_script')}
            </Button>
          </div>
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
                {t('etl.vocab_generated', {
                  count: result.count,
                  files: (result.written ?? []).map((a) => (
                    a === 'csv' ? mappingExportPath(STCM_EXPORT)
                      : a === 'script' ? VOCAB_SCRIPT_NAME
                        : PRUNE_SCRIPT_NAME
                  )).join(', '),
                })}
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
