import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Database, Info, Loader2, Pause, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { SectionLabel } from '@/components/ui/section-label'
import { MULTI_SELECT_FORM_TRIGGER, MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { cn } from '@/lib/utils'
import {
  DEFAULT_PROFILE_OPTIONS,
  availableSections,
  resolveProfileSource,
  type ProfileOptions,
  type ProfileSections,
} from '@/lib/concept-mapping/concept-profile'
import {
  EXTRACTION_COLUMNS,
  EXTRACTION_COLUMN_MAPPING,
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
  const { running, error } = snapshot
  // Live position during a run. The persisted `extracted` only moves between
  // save points, so without this the bar would sit still for hundreds of concepts.
  const liveExtracted = snapshot.extracted

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
  const total = saved?.total ?? 0
  const done = total > 0 && extracted >= total
  const percent = total > 0 ? Math.min(100, Math.round((extracted / total) * 100)) : 0

  /** Persist progress after each batch, so a reload resumes rather than restarts. */
  const persist = useCallback(async (state: SourceExtraction, csv: string, rowCount: number) => {
    await updateMappingProject(project.id, {
      sourceExtraction: state,
      fileSourceData: {
        fileName: 'source-concepts.csv',
        rows: [],
        columns: [...EXTRACTION_COLUMNS],
        columnMapping: EXTRACTION_COLUMN_MAPPING,
        rawFileBuffer: new TextEncoder().encode(csv),
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

    startRun({
      projectId: project.id,
      mapping,
      sources,
      options,
      // A restart re-counts: the dictionaries may have grown since the last run,
      // and resuming against a stale total would stop short of the new rows.
      resumeFrom: restart ? null : { extracted: saved?.extracted ?? 0, total: saved?.total ?? 0 },
      // Resuming appends to what is already there; restarting starts a new file.
      existingCsv: restart ? null : readExistingCsv(project),
      query: (sql) => queryDataSource(dataSource.id, sql),
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
    persist, updateMappingProject,
  ])

  const stop = useCallback(() => pauseRun(project.id), [project.id])

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

  return (
    // Tooltips explain the options rather than merely labelling them, so they
    // need a beat before the first one appears — otherwise moving across the
    // panel flashes them — but none between one row and the next, since reading
    // down a list is a single act of comparison.
    //
    // The skip window is short on purpose: it is global to the provider, so a
    // long one also covers leaving the dropdown entirely, and coming back would
    // fire a tooltip instantly. 300ms spans a row-to-row move and little else.
    <TooltipProvider delayDuration={500} skipDelayDuration={300}>
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-3 overflow-auto px-6 py-4">
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-center gap-1.5">
          <SectionLabel as="h3">{t('concept_mapping.extract_title')}</SectionLabel>
          <Tooltip>
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
              {saved?.updatedAt && !running
                ? (done
                  ? t('concept_mapping.extract_complete', { date: new Date(saved.updatedAt).toLocaleString(i18n.language) })
                  : t('concept_mapping.extract_paused', { date: new Date(saved.updatedAt).toLocaleString(i18n.language) }))
                : t('concept_mapping.extract_progress')}
            </span>
            {total > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {t('concept_mapping.extract_progress_count', {
                  extracted: extracted.toLocaleString(i18n.language),
                  total: total.toLocaleString(i18n.language),
                })}
              </span>
            )}
          </div>

          <Progress value={percent} />

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
    </div>
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
      <Tooltip>
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
function readExistingCsv(project: MappingProject): string | null {
  const buffer = project.fileSourceData?.rawFileBuffer
  if (!buffer?.byteLength) return null
  return new TextDecoder().decode(buffer)
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Database size={28} className="text-muted-foreground/50" />
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
    </div>
  )
}
