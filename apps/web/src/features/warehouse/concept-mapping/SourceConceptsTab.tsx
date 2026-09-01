import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Database, Info, Loader2, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { SectionLabel } from '@/components/ui/section-label'
import { MULTI_SELECT_FORM_TRIGGER, MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { queryDataSource, queryDataSourceAll } from '@/lib/duckdb/engine'
import { cn } from '@/lib/utils'
import {
  DEFAULT_PROFILE_OPTIONS,
  availableSections,
  resolveProfileSource,
  type ProfileOptions,
  type ProfileSections,
} from '@/lib/concept-mapping/concept-profile'
import {
  DEFAULT_EXTRACTION_SORT,
  EXTRACTION_COLUMNS,
  EXTRACTION_COLUMN_MAPPING,
  extractionCsvHeader,
  sortNeedsCounts,
  type ExtractionSort,
  type ExtractionSortKey,
} from '@/lib/concept-mapping/source-extraction'
import {
  clearRunError,
  getRunSnapshot,
  pauseRun,
  startRun,
  watchRun,
  type RunSnapshot,
} from '@/lib/concept-mapping/extraction-runner'
import type { DataSource, MappingProject, SourceExtraction } from '@/types'

interface SourceConceptsTabProps {
  project: MappingProject
  dataSource?: DataSource
}

/**
 * The profile blocks, in the order they are offered.
 *
 * Ordered the way you read a concept you have never seen: first how much of it
 * there is, then what its values ARE, and finally where the records came from.
 * Grouped contiguously, because the dropdown heads each run with the name of the
 * detail-view block it feeds — see SECTION_GROUPS.
 */
const SECTION_KEYS: (keyof ProfileSections)[] = [
  // Volume and coverage — how much of this concept there is.
  'missingRate',
  'perPatient',
  'frequency',
  // Values — what the records actually hold.
  'numeric',
  'histogram',
  'unit',
  'categorical',
  // Context — where and when the records came from.
  'temporal',
  'hospitalUnits',
]

/**
 * The orders a dictionary can be walked in, busiest first.
 *
 * `records` leads because it is the answer most of the time: an extraction runs
 * for hours, and the concepts a mapping project lives on are the ones the
 * warehouse actually holds data for. The dictionary orders itself by the last
 * three at no cost; the first two need the counting pass.
 */
const SORT_KEYS: ExtractionSortKey[] = ['records', 'patients', 'name', 'code', 'id']

/**
 * Which block of the concept detail view each option ends up in.
 *
 * The same three headings the profile is READ under, so the choice of what to
 * compute and the result it produces are described in one vocabulary. The keys
 * are i18n suffixes, resolved against `concept_mapping.extract_group_*`.
 */
const SECTION_GROUPS: Record<keyof ProfileSections, string> = {
  missingRate: 'volume',
  perPatient: 'volume',
  frequency: 'volume',
  numeric: 'values',
  histogram: 'values',
  unit: 'values',
  categorical: 'values',
  temporal: 'context',
  hospitalUnits: 'context',
}

/**
 * The client-only build's growing CSV, per project.
 *
 * Module scope, not a component ref: the run outlives the tab, so a buffer held
 * in the component would be replaced by a fresh empty one on remount while the
 * still-running loop kept appending to the old — two divergent copies of the
 * same file. Keyed like the run itself, so both survive leaving the tab.
 *
 * Server mode never touches this: there the rows are appended to the stored
 * blob and neither side holds the whole file.
 */
const localCsvBuffers = new Map<string, { current: string | null }>()

function localCsvFor(projectId: string): { current: string | null } {
  let buffer = localCsvBuffers.get(projectId)
  if (!buffer) {
    buffer = { current: null }
    localCsvBuffers.set(projectId, buffer)
  }
  return buffer
}

/**
 * Extract a database project's source concepts, resumably.
 *
 * Only shown for a database source. Reading a clinical database's dictionary is
 * not like reading an imported CSV: profiling each concept scans the event
 * tables, which on a real warehouse is minutes to hours. So it is never done
 * implicitly — this tab is where it is started, watched, paused and resumed.
 *
 * The unit of progress is the CONCEPT, not the batch: the stored offset counts
 * concepts and a resume picks up at the next one, so pausing costs at most the
 * handful profiled since the last save.
 *
 * What it produces is the same flat CSV an import would have given, which is
 * what lets the editor, the export and the git sync treat both kinds of project
 * identically from here on.
 */
export function SourceConceptsTab({ project, dataSource }: SourceConceptsTabProps) {
  const { t, i18n } = useTranslation()
  const updateMappingProject = useConceptMappingStore((s) => s.updateMappingProject)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  const mapping = dataSource?.schemaMapping
  const dictionaries = useMemo(() => mapping?.conceptTables ?? [], [mapping])

  const saved = project.sourceExtraction
  // Every dictionary by default: a project's source concepts are all of them,
  // and starting on one meant a full extraction took as many manual runs as the
  // schema has dictionaries.
  const [dictionaryKeys, setDictionaryKeys] = useState<string[]>(
    saved?.dictionaryKeys ?? dictionaries.map((d) => d.key),
  )
  const [options, setOptions] = useState<ProfileOptions>(saved?.options ?? DEFAULT_PROFILE_OPTIONS)
  const [sort, setSort] = useState<ExtractionSort>(saved?.sort ?? DEFAULT_EXTRACTION_SORT)

  // Re-adopt the stored settings whenever a different run turns up: the state
  // above is seeded once at mount, so a project that finished loading after the
  // tab rendered — or an extraction started from another tab — would otherwise
  // leave the controls showing defaults while the progress bar shows the real
  // run. Keyed on the run's own start, so it does not fight the user's edits
  // between batches.
  const adoptedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!saved) return
    const runKey = `${saved.dictionaryKeys.join(',')}|${saved.total}`
    if (adoptedRef.current === runKey) return
    adoptedRef.current = runKey
    setDictionaryKeys(saved.dictionaryKeys)
    setOptions(saved.options)
    setSort(saved.sort ?? DEFAULT_EXTRACTION_SORT)
  }, [saved])

  // The default above is computed at mount, when the schema may not have loaded
  // yet and there is nothing to select. Fill it in once the dictionaries arrive,
  // but only while the user has made no choice of their own.
  const seededRef = useRef(false)
  useEffect(() => {
    if (saved || seededRef.current || dictionaries.length === 0) return
    seededRef.current = true
    setDictionaryKeys((keys) => (keys.length > 0 ? keys : dictionaries.map((d) => d.key)))
  }, [saved, dictionaries])

  // The run itself lives in the module-level registry, not here: leaving the tab
  // must not stop an extraction that takes hours. This only mirrors what the run
  // reports — including a run this component never started.
  const [snapshot, setSnapshot] = useState<RunSnapshot>(() => getRunSnapshot(project.id))
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // Client-only mode has no blob store to append to, so the growing CSV lives
  // in the browser. Server mode never fills it — the bytes stay on the server.
  const localCsv = localCsvFor(project.id)
  const { running, error, phase } = snapshot
  // Live position during a run. The persisted `extracted` only moves between
  // save points, so without this the bar would sit still for hundreds of concepts.
  const liveExtracted = snapshot.extracted
  const counting = phase === 'counting'
  const ranking = phase === 'ranking'
  // Neither phase has an offset to show: both precede the first concept.
  const preparing = counting || ranking

  /** The dictionaries to walk, in a fixed order, with their event tables resolved. */
  const sources = useMemo(() => {
    if (!mapping) return []
    return dictionaries
      .filter((d) => dictionaryKeys.includes(d.key))
      .map((d) => resolveProfileSource(mapping, d.key))
      .filter((s): s is NonNullable<typeof s> => !!s)
  }, [mapping, dictionaries, dictionaryKeys])

  /**
   * What the SELECTED dictionaries can produce between them.
   *
   * A block is offered when at least one of them can back it — the extraction
   * skips it per dictionary anyway, so hiding it because a second dictionary
   * lacks the column would withhold data the first one has.
   */
  const available = useMemo(() => {
    if (!mapping || sources.length === 0) return null
    return sources.reduce<ProfileSections | null>((acc, s) => {
      const one = availableSections(mapping, s)
      if (!acc) return one
      const merged = {} as ProfileSections
      for (const key of SECTION_KEYS) merged[key] = acc[key] || one[key]
      return merged
    }, null)
  }, [mapping, sources])

  // Follow the project's run for as long as this view is mounted. Unsubscribing
  // deliberately does NOT stop it — a tab that was left is not a cancellation.
  useEffect(() => {
    setSnapshot(getRunSnapshot(project.id))
    return watchRun(project.id, setSnapshot)
  }, [project.id])

  const extracted = liveExtracted ?? saved?.extracted ?? 0
  // A run in flight is the authority on its own total: the persisted one still
  // describes the previous run until the first save point, which is what left a
  // restart showing the old "1,066 of 5,636" while it re-counted.
  const total = (running ? snapshot.total : null) ?? saved?.total ?? 0
  const done = !running && total > 0 && extracted >= total
  const percent = total > 0 ? Math.min(100, Math.round((extracted / total) * 100)) : 0

  /**
   * Persist progress after each batch, so a reload resumes rather than restarts.
   *
   * Only the new rows are written. In server mode they are appended to the
   * stored blob, so neither side ever holds the whole CSV — it reaches tens of
   * megabytes over a run, and re-encoding and re-uploading it at every save
   * point was quadratic and froze the tab.
   *
   * The client-only path has no blob store, so it keeps the browser-side buffer
   * and grows it here. That build has no server round trip to pay for, and its
   * files are the small ones.
   */
  const persist = useCallback(async (
    state: SourceExtraction,
    csvChunk: string,
    rowCount: number,
    reset: boolean,
  ) => {
    const { isServerMode } = await import('@/lib/api-client')
    if (isServerMode()) {
      const { appendRawFileOnServer } = await import('@/lib/api/mapping-projects')
      if (csvChunk) await appendRawFileOnServer(project.id, csvChunk, reset)
      await updateMappingProject(project.id, {
        sourceExtraction: state,
        fileSourceData: {
          fileName: 'source-concepts.csv',
          rows: [],
          columns: [...EXTRACTION_COLUMNS],
          columnMapping: EXTRACTION_COLUMN_MAPPING,
          totalRowCount: rowCount,
        },
      })
      return
    }

    const previous = reset ? '' : (localCsv.current ?? '')
    const next = previous + csvChunk
    localCsv.current = next
    await updateMappingProject(project.id, {
      sourceExtraction: state,
      fileSourceData: {
        fileName: 'source-concepts.csv',
        rows: [],
        columns: [...EXTRACTION_COLUMNS],
        columnMapping: EXTRACTION_COLUMN_MAPPING,
        rawFileBuffer: new TextEncoder().encode(next),
        totalRowCount: rowCount,
      },
    })
  }, [project.id, updateMappingProject])

  const run = useCallback(async (restart: boolean) => {
    if (!mapping || sources.length === 0 || !dataSource) return
    clearRunError(project.id)
    try {
      // Mounting can fail (a moved file, a dropped connection), and it is the one
      // step that must finish before the run can be handed over.
      await ensureMounted(dataSource.id)
    } catch (err) {
      setSnapshot((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }))
      return
    }

    // Server mode appends to the stored blob, so a resume needs nothing read
    // back. The client-only build has no blob store and grows the CSV in memory,
    // so THAT path still has to recover it — and must refuse rather than append
    // to a file it could not read, which would silently drop everything already
    // extracted.
    if (!restart && saved && saved.extracted > 0) {
      const { isServerMode } = await import('@/lib/api-client')
      if (!isServerMode() && localCsv.current == null) {
        const recovered = await readExistingCsv(project)
        if (!recovered) {
          setSnapshot((s) => ({ ...s, error: t('concept_mapping.extract_resume_unavailable') }))
          return
        }
        localCsv.current = recovered
      }
    }

    // Zero the stored run before the new one starts counting: a reload during
    // that window would otherwise resume the run being replaced. Written as a
    // fresh record rather than cleared — an absent key is dropped by
    // JSON.stringify, and the API's exclude_unset would never see the change.
    if (restart && saved) {
      localCsv.current = null
      await persist(
        {
          dictionaryKeys: sources.map((s) => s.dictionary.key),
          extracted: 0,
          total: 0,
          options,
          sort,
          updatedAt: new Date().toISOString(),
        },
        extractionCsvHeader(), 0, true,
      )
    }

    startRun({
      projectId: project.id,
      mapping,
      sources,
      options,
      // A resume must walk the order its run was started in, not whatever the
      // dropdown shows now: the offset is an index into that order. A restart —
      // or a first run — takes the current choice.
      sort: !restart && saved ? (saved.sort ?? DEFAULT_EXTRACTION_SORT) : sort,
      // A restart re-counts: the dictionaries may have grown since the last run,
      // and resuming against a stale total would stop short of the new rows.
      resumeFrom: restart
        ? null
        : { extracted: saved?.extracted ?? 0, total: saved?.total ?? 0, sizes: saved?.sizes },
      query: (sql) => queryDataSource(dataSource.id, sql),
      queryAll: (sql) => queryDataSourceAll(dataSource.id, sql),
      persist,
      persistError: async (message) => {
        if (!saved) return
        await updateMappingProject(project.id, {
          sourceExtraction: { ...saved, error: message, updatedAt: new Date().toISOString() },
        })
      },
    })
  }, [
    mapping, sources, dataSource, ensureMounted, saved, project, options,
    persist, updateMappingProject, sort, t,
  ])

  const stop = useCallback(() => pauseRun(project.id), [project.id])

  /**
   * Throw the extraction away, unlocking the settings.
   *
   * The dictionaries and the sort are locked while a run exists because a resume
   * is an offset into the order that run started in — changing either mid-way
   * would skip some concepts and profile others twice. Discarding is the honest
   * way back: it drops the concepts, so the choice is a real one rather than a
   * setting that silently corrupts a half-finished run.
   *
   * Sent as explicit nulls: JSON.stringify drops `undefined`, and the API's
   * exclude_unset would then read the key as "no change" and keep the old value.
   */
  const discard = useCallback(async () => {
    setConfirmDiscard(false)
    clearRunError(project.id)
    localCsv.current = null
    // Drop the module-level entry too, not just its contents: it outlives the
    // component, and a discarded extraction's CSV can be tens of megabytes.
    localCsvBuffers.delete(project.id)
    await updateMappingProject(project.id, {
      sourceExtraction: null,
      fileSourceData: null,
      // Server-only field, and it has to go with the rest: the export reads the
      // blob by this sha alone, so leaving it set would keep shipping the CSV of
      // an extraction the project no longer claims to have. Nulling it also
      // releases the blob (mapping_project_service.update).
      rawFileSha: null,
    } as unknown as Partial<MappingProject>)
    setSnapshot(getRunSnapshot(project.id))
  }, [project.id, updateMappingProject])

  if (!dataSource || !mapping) {
    return <EmptyState message={t('concept_mapping.extract_no_database')} />
  }
  if (dictionaries.length === 0) {
    return <EmptyState message={t('concept_mapping.extract_no_dictionary')} />
  }

  const sectionOptions = SECTION_KEYS
    .filter((key) => available?.[key])
    .map((key) => ({
      value: key,
      label: t(`concept_mapping.extract_section_${key}`),
      group: t(`concept_mapping.extract_group_${SECTION_GROUPS[key]}`),
    }))
  const selectedSections = sectionOptions
    .map((o) => o.value)
    .filter((key) => options.sections[key as keyof ProfileSections])
  const locked = running || (!!saved && !done)
  // "Largest first" reads better than "descending" for a count; "A to Z" better
  // than "ascending" for a name. Same control, named for what it orders.
  const sortIsNumeric = sort.key === 'records' || sort.key === 'patients' || sort.key === 'id'

  return (
    // These delays govern the OPTION ROWS. Their tooltips explain the options
    // rather than merely labelling them, so they need a beat before the first
    // one appears — otherwise moving across the panel flashes them — but none
    // between one row and the next, since reading down a list is a single act of
    // comparison. The info icons opt out with delayDuration={0}: a small target
    // hovered on purpose has already asked the question.
    //
    // The skip window is short on purpose: it is global to the provider, so a
    // long one also covers leaving the dropdown entirely, and coming back would
    // fire a tooltip instantly. 300ms spans a row-to-row move and little else.
    <TooltipProvider delayDuration={500} skipDelayDuration={300}>
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-3 overflow-auto px-6 py-4">
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-center gap-1.5">
          <SectionLabel as="h3">{t('concept_mapping.extract_title')}</SectionLabel>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Info">
                <Info size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-sm text-xs">
              {t('concept_mapping.extract_description')}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* What to walk, and what to compute for each concept */}
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-1.5">
            <Label>{t('concept_mapping.extract_dictionary')}</Label>
            <MultiSelectFilter
              value={dictionaryKeys}
              options={dictionaries.map((d) => ({ value: d.key, label: d.table }))}
              placeholder={t('concept_mapping.extract_dictionary_placeholder')}
              onChange={setDictionaryKeys}
              showChevron
              popoverWidthClass="w-64"
              triggerClass={cn(MULTI_SELECT_FORM_TRIGGER, locked && 'pointer-events-none opacity-50')}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{t('concept_mapping.extract_sections')}</Label>
            <MultiSelectFilter
              value={selectedSections}
              options={sectionOptions}
              placeholder={t('concept_mapping.extract_sections_placeholder')}
              onChange={(next) => setOptions((o) => {
                const sections = { ...o.sections }
                for (const key of SECTION_KEYS) sections[key] = next.includes(key)
                return { ...o, sections }
              })}
              // The labels alone cannot separate "descriptive statistics" from
              // "value distribution", nor a measurement's unit from a hospital
              // ward. The explanation belongs on the row it explains.
              renderOption={(opt) => (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="truncate">{opt.label}</span>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-xs text-xs">
                    {t(`concept_mapping.extract_section_${opt.value}_desc`)}
                  </TooltipContent>
                </Tooltip>
              )}
              groupOptions
              showChevron
              popoverWidthClass="w-72"
              triggerClass={cn(MULTI_SELECT_FORM_TRIGGER, running && 'pointer-events-none opacity-50')}
            />
          </div>
        </div>

        {/* What to screen first, and from which end */}
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-1.5">
            <LabelWithHint
              htmlFor="extract-sort"
              label={t('concept_mapping.extract_sort')}
              hint={t('concept_mapping.extract_sort_hint')}
            />
            <Select
              value={sort.key}
              disabled={locked}
              onValueChange={(key) => setSort((s) => ({ ...s, key: key as ExtractionSortKey }))}
            >
              <SelectTrigger id="extract-sort" className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_KEYS.map((key) => (
                  <SelectItem key={key} value={key} className="text-xs">
                    {t(`concept_mapping.extract_sort_${key}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="extract-sort-direction">{t('concept_mapping.extract_sort_direction')}</Label>
            <Select
              value={sort.direction}
              disabled={locked}
              onValueChange={(d) => setSort((s) => ({ ...s, direction: d as 'asc' | 'desc' }))}
            >
              <SelectTrigger id="extract-sort-direction" className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Named for what they mean per key — "largest first" reads
                    better than "descending" for a record count, and the same
                    control also orders names. */}
                <SelectItem value="desc" className="text-xs">
                  {t(`concept_mapping.extract_sort_desc_${sortIsNumeric ? 'numeric' : 'text'}`)}
                </SelectItem>
                <SelectItem value="asc" className="text-xs">
                  {t(`concept_mapping.extract_sort_asc_${sortIsNumeric ? 'numeric' : 'text'}`)}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {sortNeedsCounts(sort) && !locked && (
          <p className="-mt-2 text-[10px] text-muted-foreground">
            {t('concept_mapping.extract_sort_counts_warning')}
          </p>
        )}

        {/* The two confidentiality thresholds */}
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-1.5">
            <LabelWithHint
              htmlFor="extract-min-patients"
              label={t('concept_mapping.extract_min_patients')}
              hint={t('concept_mapping.extract_min_patients_hint')}
            />
            <Input
              id="extract-min-patients"
              type="number"
              min={0}
              value={options.minPatients}
              disabled={running}
              onChange={(e) => setOptions((o) => ({
                ...o, minPatients: Math.max(0, parseInt(e.target.value) || 0),
              }))}
              className="h-8 text-xs"
            />
          </div>
          <div className="grid gap-1.5">
            <LabelWithHint
              htmlFor="extract-min-category"
              label={t('concept_mapping.extract_min_category')}
              hint={t('concept_mapping.extract_min_category_hint')}
            />
            <Input
              id="extract-min-category"
              type="number"
              min={0}
              value={options.minCategoryCount}
              disabled={running}
              onChange={(e) => setOptions((o) => ({
                ...o, minCategoryCount: Math.max(0, parseInt(e.target.value) || 0),
              }))}
              className="h-8 text-xs"
            />
          </div>
        </div>

        {/* Progress + controls */}
        <div className="flex flex-col gap-2 border-t pt-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {/* Counting is one COUNT per dictionary against the database, and
                  says so: silence here reads as a button that did nothing. */}
              {counting
                ? t('concept_mapping.extract_counting')
                : ranking
                ? t('concept_mapping.extract_ranking')
                : saved?.updatedAt && !running
                  ? (done
                    ? t('concept_mapping.extract_complete', { date: new Date(saved.updatedAt).toLocaleString(i18n.language) })
                    : t('concept_mapping.extract_paused', { date: new Date(saved.updatedAt).toLocaleString(i18n.language) }))
                  : t('concept_mapping.extract_progress')}
            </span>
            {total > 0 && !preparing && (
              <CurrentConceptTooltip concept={running ? snapshot.current : null}>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t('concept_mapping.extract_progress_count', {
                    extracted: extracted.toLocaleString(i18n.language),
                    total: total.toLocaleString(i18n.language),
                  })}
                </span>
              </CurrentConceptTooltip>
            )}
          </div>

          <Progress value={preparing ? 0 : percent} />

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive">
              <AlertCircle size={14} className="mt-px shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2">
            {running ? (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={stop}>
                <Pause size={14} />
                {t('concept_mapping.extract_pause')}
              </Button>
            ) : (
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => run(false)}
                disabled={sources.length === 0 || done}
              >
                <Play size={14} />
                {saved && extracted > 0
                  ? t('concept_mapping.extract_resume')
                  : t('concept_mapping.extract_start')}
              </Button>
            )}
            {!!saved && !running && (
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setConfirmRestart(true)}>
                <RotateCcw size={14} />
                {t('concept_mapping.extract_restart')}
              </Button>
            )}
            {/* Start over re-runs with the settings locked to the run it is
                replacing. Discarding is the way back to an unlocked panel: it
                throws away the extracted concepts, so it is destructive and says
                so, and it is the only way to change the dictionaries. */}
            {!!saved && !running && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setConfirmDiscard(true)}
              >
                <Trash2 size={14} />
                {t('concept_mapping.extract_discard')}
              </Button>
            )}
            {running && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
          </div>

          {/* Two sentences, two lines: the first says the work is done, the
              second what that now makes possible. Run together on the button
              row they read as one long aside and got skipped. */}
          {done && (
            <div className="flex flex-col gap-0.5 pt-1 text-[10px] text-muted-foreground">
              <span>{t('concept_mapping.extract_done_hint')}</span>
              <span>{t('concept_mapping.extract_done_hint_travels')}</span>
            </div>
          )}
        </div>
      </Card>

      <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.extract_restart_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.extract_restart_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmRestart(false); void run(true) }}>
              {t('concept_mapping.extract_restart')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.extract_discard_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.extract_discard_description', {
                count: extracted,
                formattedCount: extracted.toLocaleString(i18n.language),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void discard()}
            >
              {t('concept_mapping.extract_discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </TooltipProvider>
  )
}

/**
 * How long a pointer must rest on the counter before it answers.
 *
 * Long enough that crossing the row on the way to Pause never triggers it,
 * short enough that someone who stopped to ask is not left waiting.
 */
const CURRENT_CONCEPT_DELAY = 1800

/**
 * What the run is profiling right now, after a deliberate pause on the counter.
 *
 * Deliberately slower than the usual beat: at fifty concepts a second the
 * counter is a blur, and someone whose pointer crosses it on the way to the
 * Pause button has not asked what concept is in flight. Someone who stops on it
 * has.
 *
 * The concept is frozen when the tooltip opens rather than tracked live — a
 * label rewriting itself fifty times a second cannot be read, and the question
 * being asked is "what is it on", which one answer settles.
 */

function CurrentConceptTooltip({
  concept,
  children,
}: {
  concept: { conceptCode: string; conceptName: string } | null
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [frozen, setFrozen] = useState<typeof concept>(null)

  if (!concept) return <>{children}</>

  return (
    // Its own provider: the panel's skip window would let this open instantly
    // right after another tooltip closed, defeating the deliberate pause this
    // control is gated on.
    <TooltipProvider delayDuration={CURRENT_CONCEPT_DELAY} skipDelayDuration={0}>
    <Tooltip
      open={open}
      delayDuration={CURRENT_CONCEPT_DELAY}
      onOpenChange={(next) => {
        if (next) setFrozen(concept)
        setOpen(next)
      }}
    >
      <TooltipTrigger asChild>
        <span>{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-xs text-xs">
        <p className="text-[10px] uppercase tracking-wide opacity-70">
          {t('concept_mapping.extract_current_concept')}
        </p>
        <p className="font-mono">{frozen?.conceptCode}</p>
        <p className="break-words">{frozen?.conceptName}</p>
      </TooltipContent>
    </Tooltip>
    </TooltipProvider>
  )
}

/**
 * A field label with its explanation behind an info icon.
 *
 * The explanations here are worth reading once and never again, so they sit on
 * hover rather than under every field — a column of permanent hint text made
 * the panel scroll for no lasting benefit.
 */
function LabelWithHint({
  htmlFor,
  label,
  hint,
}: {
  htmlFor: string
  label: string
  hint: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {/* No delay: an info icon is aimed at deliberately, unlike the option rows
          whose tooltips need a beat so crossing the list does not flash them. */}
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Info">
            <Info size={12} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs text-xs">
          {hint}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/** The CSV written so far, so a resumed run appends instead of replacing. */
async function readExistingCsv(project: MappingProject): Promise<string | null> {
  const buffer = project.fileSourceData?.rawFileBuffer
  if (buffer?.byteLength) return new TextDecoder().decode(buffer)

  // Server mode never sends the bytes back down — the upload strips them and the
  // project only carries metadata afterwards. Without this the buffer read as
  // absent on every resume, so the run started a fresh header and the CSV was
  // truncated to whatever was extracted since: a finished 5,636-concept run left
  // a file holding only the last 1,622.
  if (!project.fileSourceData) return null
  try {
    const { isServerMode } = await import('@/lib/api-client')
    if (!isServerMode()) return null
    const { fetchRawFileFromServer } = await import('@/lib/api/mapping-projects')
    const fetched = await fetchRawFileFromServer(project.id)
    return fetched?.byteLength ? new TextDecoder().decode(fetched) : null
  } catch {
    return null
  }
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Database size={28} className="text-muted-foreground/50" />
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
    </div>
  )
}
