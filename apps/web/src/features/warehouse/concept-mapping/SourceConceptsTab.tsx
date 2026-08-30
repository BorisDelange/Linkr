import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Database, Info, Loader2, Play, RotateCcw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { SectionLabel } from '@/components/ui/section-label'
import { MULTI_SELECT_FORM_TRIGGER, MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
  effectiveSections,
  resolveProfileSource,
  type ProfileOptions,
  type ProfileSections,
} from '@/lib/concept-mapping/concept-profile'
import {
  EXTRACTION_COLUMNS,
  EXTRACTION_COLUMN_MAPPING,
  buildDictionaryCountQuery,
  extractBatch,
  extractionCsvHeader,
  extractionCsvRows,
} from '@/lib/concept-mapping/source-extraction'
import type { DataSource, MappingProject, SourceExtraction } from '@/types'

interface SourceConceptsTabProps {
  project: MappingProject
  dataSource?: DataSource
}

/** Batch sizes offered. Small enough to stop quickly, large enough to be worth a run. */
const BATCH_SIZES = [100, 500, 1000, 5000]

/** The profile blocks, in the order they are offered. */
const SECTION_KEYS: (keyof ProfileSections)[] = [
  'numeric', 'histogram', 'categorical', 'unit',
  'frequency', 'temporal', 'hospitalUnits', 'missingRate',
]

/**
 * Extract a database project's source concepts, in batches the user controls.
 *
 * Only shown for a database source. Reading a clinical database's dictionary is
 * not like reading an imported CSV: profiling each concept scans the event
 * tables, which on a real warehouse is minutes to hours. So it is never done
 * implicitly — this tab is where it is started, watched, stopped and resumed.
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
  const [dictionaryKeys, setDictionaryKeys] = useState<string[]>(
    saved?.dictionaryKeys ?? (dictionaries[0] ? [dictionaries[0].key] : []),
  )
  const [batchSize, setBatchSize] = useState(saved?.batchSize ?? 500)
  const [options, setOptions] = useState<ProfileOptions>(saved?.options ?? DEFAULT_PROFILE_OPTIONS)

  const [running, setRunning] = useState(false)
  // Live position during a run. The persisted `extracted` only moves between
  // batches, so without this the bar would sit still for a whole batch.
  const [liveExtracted, setLiveExtracted] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

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

  // Stop the run when the tab goes away: its batches write to the project, and a
  // run outliving the view would keep doing so behind the user's back.
  useEffect(() => () => abortRef.current?.abort(), [])

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
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setError(null)

    try {
      await ensureMounted(dataSource.id)
      const query = (sql: string) => queryDataSource(dataSource.id, sql)

      // A restart re-counts: the dictionaries may have grown since the last run,
      // and resuming against a stale total would stop short of the new rows.
      let offset = restart ? 0 : (saved?.extracted ?? 0)
      let runTotal = restart ? 0 : (saved?.total ?? 0)
      // Per-dictionary sizes, so a global offset can be mapped onto the right one.
      const sizes: number[] = []
      for (const s of sources) {
        const rows = await query(buildDictionaryCountQuery(s))
        sizes.push(Number(rows[0]?.total ?? 0))
      }
      if (runTotal === 0) runTotal = sizes.reduce((a, b) => a + b, 0)

      // Resuming appends to what is already there; restarting starts a new file.
      let csv = restart ? extractionCsvHeader() : readExistingCsv(project) ?? extractionCsvHeader()
      const keys = sources.map((s) => s.dictionary.key)

      setLiveExtracted(offset)
      while (!controller.signal.aborted && offset < runTotal) {
        // Which dictionary the global offset falls in, and where inside it.
        let index = 0
        let local = offset
        while (index < sizes.length && local >= sizes[index]) {
          local -= sizes[index]
          index++
        }
        if (index >= sources.length) break

        const source = sources[index]
        const sections = effectiveSections(options.sections, availableSections(mapping, source))
        const batch = await extractBatch(
          mapping, source, { ...options, sections }, local,
          // Never read past this dictionary's end in one batch: the next one has
          // its own columns, and mixing them into one page would misread them.
          Math.min(batchSize, sizes[index] - local),
          runTotal, query, controller.signal,
          (n) => setLiveExtracted(offset - local + n),
        )
        if (batch.rows.length > 0) csv += `\n${extractionCsvRows(batch.rows)}`
        // A batch that yields nothing and is not done would spin forever.
        if (batch.rows.length === 0 && !batch.done) break
        offset += batch.rows.length

        await persist(
          {
            dictionaryKeys: keys, extracted: offset, total: runTotal, batchSize,
            options: { ...options, sections }, updatedAt: new Date().toISOString(),
          },
          csv, offset,
        )
      }
      setLiveExtracted(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setLiveExtracted(null)
      if (saved) {
        await updateMappingProject(project.id, {
          sourceExtraction: { ...saved, error: message, updatedAt: new Date().toISOString() },
        })
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }, [
    mapping, sources, dataSource, ensureMounted, saved, project, options,
    batchSize, persist, updateMappingProject,
  ])

  const stop = useCallback(() => abortRef.current?.abort(), [])

  if (!dataSource || !mapping) {
    return <EmptyState message={t('concept_mapping.extract_no_database')} />
  }
  if (dictionaries.length === 0) {
    return <EmptyState message={t('concept_mapping.extract_no_dictionary')} />
  }

  const sectionOptions = SECTION_KEYS
    .filter((key) => available?.[key])
    .map((key) => ({ value: key, label: t(`concept_mapping.extract_section_${key}`) }))
  const selectedSections = sectionOptions
    .map((o) => o.value)
    .filter((key) => options.sections[key as keyof ProfileSections])
  const locked = running || (!!saved && !done)

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-3 overflow-auto px-6 py-4">
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-center gap-1.5">
          <SectionLabel as="h3">{t('concept_mapping.extract_title')}</SectionLabel>
          <Tooltip delayDuration={200}>
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

        {/* Scope: which dictionaries, how big a batch */}
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
            <Label>{t('concept_mapping.extract_batch_size')}</Label>
            <MultiSelectFilter
              value={[String(batchSize)]}
              options={BATCH_SIZES.map((n) => ({ value: String(n), label: n.toLocaleString(i18n.language) }))}
              placeholder=""
              // Single-valued: keep the last click rather than accumulating.
              onChange={(next) => {
                const picked = next.find((v) => v !== String(batchSize)) ?? next[0]
                if (picked) setBatchSize(Number(picked))
              }}
              showChevron
              popoverWidthClass="w-40"
              triggerClass={cn(MULTI_SELECT_FORM_TRIGGER, running && 'pointer-events-none opacity-50')}
            />
          </div>
        </div>

        {/* What to compute, and the two confidentiality thresholds */}
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
            showChevron
            popoverWidthClass="w-72"
            triggerClass={cn(MULTI_SELECT_FORM_TRIGGER, running && 'pointer-events-none opacity-50')}
          />
        </div>

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
                <Square size={14} />
                {t('concept_mapping.extract_stop')}
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
            {done && (
              <span className="ml-auto text-[10px] text-muted-foreground">
                {t('concept_mapping.extract_done_hint')}
              </span>
            )}
          </div>
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
      <Tooltip delayDuration={200}>
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
