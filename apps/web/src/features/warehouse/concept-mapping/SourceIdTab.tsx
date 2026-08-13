import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, RefreshCw, Hash, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { getStorage } from '@/lib/storage'
import { localized } from '@/lib/localized'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { queryDataSourceAll, mountFileSourceIntoDuckDB, fileSourceDataSourceId } from '@/lib/duckdb/engine'
import { buildSourceConceptsAllQuery } from '@/lib/concept-mapping/mapping-queries'
import {
  OMOP_CUSTOM_MAX,
  OMOP_CUSTOM_MIN,
  clampNextId,
  formatRangeBound,
  parseRangeBound,
  rangeCapacity,
} from './source-id-range'
import type { MappingProject, SourceConceptIdRange, SourceConceptIdEntry } from '@/types'

const DEFAULT_RANGE_SIZE = 1_000_000

interface SourceIdTabProps {
  workspaceId: string
  projects: MappingProject[]
}

interface RangeRow extends SourceConceptIdRange {
  /** id field added by storage layer */
  id: string
  /** IDs assigned from this range's own range (sourceConceptId within [rangeStart, rangeEnd]) */
  ownCount: number
  /** Total entries for this badge (own + inherited from other badges) */
  assignedCount: number
  /** Largest id handed out from this range, null if none — the cursor alone
   *  cannot say, since it survives edits of the bounds. */
  highestOwnId: number | null
}

interface RangeEdit {
  rangeStart: string
  rangeEnd: string
}

function formatNumber(n: number) {
  return n.toLocaleString()
}

function rangeOverlaps(ranges: RangeRow[], exclude: string, start: number, end: number): boolean {
  for (const r of ranges) {
    if (r.badgeLabel === exclude) continue
    if (start <= r.rangeEnd && end >= r.rangeStart) return true
  }
  return false
}

// Session cache of the computed rows per workspace, so re-opening the Source IDs
// tab shows the counts instantly instead of refetching (Radix unmounts inactive
// tab content). Refreshed in the background on mount, and after any mutation.
const rangeCache = new Map<string, RangeRow[]>()

export function SourceIdTab({ workspaceId, projects }: SourceIdTabProps) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('concept-mapping:write')
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const [ranges, setRanges] = useState<RangeRow[]>(() => rangeCache.get(workspaceId) ?? [])
  // No spinner when we already have cached rows — refresh happens in the background.
  const [loading, setLoading] = useState(() => !rangeCache.has(workspaceId))
  const [edits, setEdits] = useState<Record<string, RangeEdit>>({})
  const [assignLoading, setAssignLoading] = useState<string | null>(null)
  const [assignResult, setAssignResult] = useState<{ badge: string; newlyAssigned: number; total: number; exhausted: boolean } | null>(null)
  // Live progress during a large assignment: { done, total } saved so far.
  const [assignProgress, setAssignProgress] = useState<{ badge: string; done: number; total: number } | null>(null)
  const [resetConfirm, setResetConfirm] = useState<string | null>(null) // badgeLabel or 'all'
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null) // badgeLabel
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Distinct badge labels across all projects
  const allBadgeLabels: string[] = Array.from(
    new Set(projects.flatMap((p) => (p.badges ?? []).map((b) => localized(b.label, 'en')).filter(Boolean))),
  ).sort()

  const load = useCallback(async () => {
    if (!rangeCache.has(workspaceId)) setLoading(true)
    const [stored, counts] = await Promise.all([
      getStorage().sourceConceptIdRanges.getByWorkspace(workspaceId),
      // Per-badge counts as integers — NOT the full entry rows. Loading every
      // entry just to .length them made this tab crawl on reload (100k+ rows).
      getStorage().sourceConceptIdEntries.getCountsByWorkspace(workspaceId),
    ])
    const countByBadge = new Map(counts.map((c) => [c.badgeLabel, c]))
    const rows: RangeRow[] = stored.map((r) => {
      const c = countByBadge.get(r.badgeLabel)
      return {
        ...r, id: `${workspaceId}__${r.badgeLabel}`,
        assignedCount: c?.assignedCount ?? 0, ownCount: c?.ownCount ?? 0,
        highestOwnId: c?.highestOwnId ?? null,
      }
    }).sort((a, b) => a.rangeStart - b.rangeStart)
    rangeCache.set(workspaceId, rows)
    setRanges(rows)
    setLoading(false)
  }, [workspaceId])

  useEffect(() => { load() }, [load])

  // Suggest next available range start
  const nextRangeStart = () => {
    if (ranges.length === 0) return OMOP_CUSTOM_MIN
    const maxEnd = Math.max(...ranges.map((r) => r.rangeEnd))
    return Math.min(maxEnd + 1, OMOP_CUSTOM_MAX)
  }

  const addBadge = async (badgeLabel: string) => {
    const start = nextRangeStart()
    const end = Math.min(start + DEFAULT_RANGE_SIZE - 1, OMOP_CUSTOM_MAX)
    if (start > OMOP_CUSTOM_MAX) return
    const now = new Date().toISOString()
    const range: SourceConceptIdRange = {
      workspaceId,
      badgeLabel,
      rangeStart: start,
      rangeEnd: end,
      nextId: start,
      createdAt: now,
      updatedAt: now,
    }
    await getStorage().sourceConceptIdRanges.save(range)
    await load()
  }

  /**
   * Why a range cannot be saved, or null when it can. Runs as the user types so
   * the bounds are reported wrong where they are entered, rather than only on a
   * rejected save.
   */
  const validateRange = (badgeLabel: string, edit: { rangeStart: string; rangeEnd: string }): string | null => {
    const start = parseRangeBound(edit.rangeStart)
    const end = parseRangeBound(edit.rangeEnd)
    if (start == null || end == null) return t('concept_mapping.source_id_error_invalid')
    if (start < OMOP_CUSTOM_MIN) return t('concept_mapping.source_id_error_min', { min: formatNumber(OMOP_CUSTOM_MIN) })
    if (end > OMOP_CUSTOM_MAX) return t('concept_mapping.source_id_error_max', { max: formatNumber(OMOP_CUSTOM_MAX) })
    if (end <= start) return t('concept_mapping.source_id_error_order')
    if (rangeOverlaps(ranges, badgeLabel, start, end)) return t('concept_mapping.source_id_error_overlap')
    return null
  }

  const saveEdit = async (badgeLabel: string) => {
    const edit = edits[badgeLabel]
    if (!edit) return
    const invalid = validateRange(badgeLabel, edit)
    if (invalid) {
      setErrors({ ...errors, [badgeLabel]: invalid })
      return
    }
    const start = parseRangeBound(edit.rangeStart) as number
    const end = parseRangeBound(edit.rangeEnd) as number

    const newErrors: Record<string, string> = { ...errors }
    delete newErrors[badgeLabel]
    setErrors(newErrors)

    const existing = ranges.find((r) => r.badgeLabel === badgeLabel)
    if (!existing) return
    const now = new Date().toISOString()
    await getStorage().sourceConceptIdRanges.save({
      ...existing,
      rangeStart: start,
      rangeEnd: end,
      // Moving the bounds has to move the cursor with them: it was allocated
      // against the old range, and assignIds starts from it verbatim. Left
      // behind, a cursor below the new start silently hands out ids outside
      // the range the user just asked for.
      nextId: clampNextId(existing.nextId, start, end, existing.highestOwnId),
      updatedAt: now,
    })
    setEdits((prev) => { const n = { ...prev }; delete n[badgeLabel]; return n })
    await load()
  }

  const assignIds = async (badgeLabel: string) => {
    setAssignLoading(badgeLabel)
    setAssignResult(null)
    setAssignProgress(null)
    try {
      const range = ranges.find((r) => r.badgeLabel === badgeLabel)
      if (!range) return

      // Gather all (vocabularyId, conceptCode) pairs from projects that have this badge
      // — includes ALL source concepts, not just mapped ones
      const projectsWithBadge = projects.filter((p) =>
        (p.badges ?? []).some((b) => localized(b.label, 'en') === badgeLabel),
      )

      if (projectsWithBadge.length === 0) {
        setAssignResult({ badge: badgeLabel, newlyAssigned: 0, total: 0, exhausted: false })
        return
      }

      // Unique (vocabularyId, conceptCode) pairs — exclude file projects with a real conceptIdColumn
      const pairsToAssign = new Set<string>()

      for (const proj of projectsWithBadge) {
        const isFile = proj.sourceType === 'file' || !!proj.fileSourceData
        if (isFile) {
          // File project with real concept IDs: skip (real IDs are used directly)
          if (proj.fileSourceData?.columnMapping?.conceptIdColumn) continue
          // Mount file source into DuckDB if needed, then query
          if (proj.fileSourceData) {
            try {
              await mountFileSourceIntoDuckDB(
                proj.id,
                proj.fileSourceData.rows,
                proj.fileSourceData.columnMapping,
                proj.fileSourceData.rawFileBuffer,
              )
              const dsId = fileSourceDataSourceId(proj.id)
              // SELECT * — vocabulary_id is only in the view when a terminology column
              // was mapped; naming it explicitly threw and silently assigned nothing.
              const rows = await queryDataSourceAll(dsId, 'SELECT * FROM source_concepts')
              for (const row of rows) {
                const code = String(row.concept_code ?? '')
                const vocab = String(row.vocabulary_id ?? proj.name)
                if (code) pairsToAssign.add(`${vocab}__${code}`)
              }
            } catch {
              // If mount/query fails, skip silently
            }
          }
        } else {
          // Database project: query all source concepts
          const ds = dataSources.find((s) => s.id === proj.dataSourceId)
          if (!ds?.schemaMapping) continue
          try {
            await ensureMounted(ds.id)
            const sql = buildSourceConceptsAllQuery(ds.schemaMapping, {})
            if (!sql) continue
            const rows = await queryDataSourceAll(ds.id, sql)
            for (const row of rows) {
              const code = String(row.concept_code || row.concept_id || '')
              const vocab = String(row.vocabulary_id ?? ds.id)
              if (code) pairsToAssign.add(`${vocab}__${code}`)
            }
          } catch {
            // If DB unavailable, skip silently
          }
        }
      }

      // Load existing entries for this badge (to skip already-assigned).
      // Scoped to the badge on purpose: an id belongs to exactly one badge, so a
      // (vocab, code) shared between centres gets a distinct id in each one. Ids
      // from several sites end up in one warehouse, where the id is what says
      // which site a row came from — reusing another badge's id would both erase
      // that origin and hand out a number outside this range's band.
      const existing = await getStorage().sourceConceptIdEntries.getByWorkspaceAndBadge(workspaceId, badgeLabel)
      const existingMap = new Map(existing.map((e) => [`${e.vocabularyId}__${e.conceptCode}`, e]))

      // Never allocate from a cursor that sits outside the range: ranges edited
      // before this was enforced carry one from their previous bounds, and the
      // loop's only check is against rangeEnd, so a low cursor would quietly
      // fill the range's quota with ids belonging to another badge's band.
      let nextId = clampNextId(range.nextId, range.rangeStart, range.rangeEnd, range.highestOwnId)
      const now = new Date().toISOString()
      let newlyAssigned = 0 // IDs consumed from this range (truly new)

      // Accumulate all new entries and persist them in ONE saveBatch — a per-entry
      // save() meant one HTTP round-trip each in server mode (183k concepts →
      // 183k requests), which is what made assignment crawl.
      const toSave: SourceConceptIdEntry[] = []
      let exhausted = false
      for (const pairKey of pairsToAssign) {
        if (existingMap.has(pairKey)) continue // already in this badge

        const sepIdx = pairKey.indexOf('__')
        const vocabularyId = pairKey.slice(0, sepIdx)
        const conceptCode = pairKey.slice(sepIdx + 2)
        const entryId = `${workspaceId}__${badgeLabel}__${vocabularyId}__${conceptCode}`

        if (nextId > range.rangeEnd) {
          exhausted = true // surfaced in the result — a silent break under-assigns
          break
        }
        const sourceConceptId = nextId
        nextId++
        newlyAssigned++

        toSave.push({
          id: entryId,
          workspaceId,
          badgeLabel,
          vocabularyId,
          conceptCode,
          sourceConceptId,
          createdAt: now,
        })
      }
      // Persist in chunks: one giant saveBatch is a single long transaction with
      // no feedback (and risks a server timeout on 100k+ rows). Chunking gives a
      // live "done / total" progress and keeps each request bounded.
      const CHUNK = 5000
      if (toSave.length > 0) {
        setAssignProgress({ badge: badgeLabel, done: 0, total: toSave.length })
        for (let i = 0; i < toSave.length; i += CHUNK) {
          await getStorage().sourceConceptIdEntries.saveBatch(toSave.slice(i, i + CHUNK))
          setAssignProgress({ badge: badgeLabel, done: Math.min(i + CHUNK, toSave.length), total: toSave.length })
        }
      }

      // Save the range with the advanced nextId and the CUMULATIVE assigned count.
      // totalConcepts must be the total concepts assigned to the badge (existing +
      // newly added this run), NOT `pairsToAssign.size` (the current run's subset):
      // assigning one project of a shared badge would otherwise shrink totalConcepts
      // below the real count, contradicting nextId (the "132%" confusion).
      await getStorage().sourceConceptIdRanges.save({
        ...range,
        nextId,
        totalConcepts: existing.length + toSave.length,
        updatedAt: now,
      })
      await load()
      setAssignResult({ badge: badgeLabel, newlyAssigned, total: pairsToAssign.size, exhausted })
    } finally {
      setAssignProgress(null)
      setAssignLoading(null)
    }
  }

  const resetBadge = async (badgeLabel: string) => {
    await getStorage().sourceConceptIdEntries.deleteByWorkspaceAndBadge(workspaceId, badgeLabel)
    const range = ranges.find((r) => r.badgeLabel === badgeLabel)
    if (range) {
      await getStorage().sourceConceptIdRanges.save({ ...range, nextId: range.rangeStart, updatedAt: new Date().toISOString() })
    }
    // The previous run's outcome describes ids that no longer exist. Left on
    // screen it reads as the result of the reset itself — "all N already
    // assigned" right after everything was cleared.
    setAssignResult(null)
    setResetConfirm(null)
    await load()
  }

  const resetAll = async () => {
    await getStorage().sourceConceptIdEntries.deleteByWorkspace(workspaceId)
    for (const range of ranges) {
      await getStorage().sourceConceptIdRanges.save({ ...range, nextId: range.rangeStart, updatedAt: new Date().toISOString() })
    }
    setAssignResult(null)
    setResetConfirm(null)
    await load()
  }

  const removeBadge = async (badgeLabel: string) => {
    await getStorage().sourceConceptIdEntries.deleteByWorkspaceAndBadge(workspaceId, badgeLabel)
    await getStorage().sourceConceptIdRanges.delete(workspaceId, badgeLabel)
    setAssignResult(null)
    setDeleteConfirm(null)
    await load()
  }

  const unregisteredBadges = allBadgeLabels.filter((l) => !ranges.some((r) => r.badgeLabel === l))

  // Ids issued across all ranges. Every id belongs to exactly one badge, so
  // summing the per-badge totals counts each one once.
  const totalAssigned = ranges.reduce((s, r) => s + r.ownCount, 0)

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-3xl space-y-5">

        {/* Header info */}
        <div className="flex gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
          <Info size={15} className="mt-0.5 shrink-0" />
          <div className="min-w-0 space-y-1 text-xs leading-relaxed">
            <p>{t('concept_mapping.source_id_info')}</p>
            <p>
              <span className="text-blue-600 dark:text-blue-400">{t('concept_mapping.source_id_range_label')}</span>
              {' '}
              <span className="font-mono font-medium">
                {formatNumber(OMOP_CUSTOM_MIN)}–{formatNumber(OMOP_CUSTOM_MAX)}
              </span>
              <span className="ml-1 text-blue-600/70 dark:text-blue-400/70">
                {t('concept_mapping.source_id_range_hint')}
              </span>
            </p>
          </div>
        </div>

        {/* Badge ranges */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{t('concept_mapping.source_id_ranges')}</p>
            {totalAssigned > 0 && (
              <Button variant="ghost" size="sm" disabled={!canWrite} className="h-7 gap-1 text-xs text-destructive hover:text-destructive" onClick={() => setResetConfirm('all')}>
                <RefreshCw size={12} />
                {t('concept_mapping.source_id_reset_all')}
              </Button>
            )}
          </div>

          {loading ? (
            <div className="py-8 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
          ) : ranges.length === 0 ? (
            <Card>
              <div className="py-8 text-center text-xs text-muted-foreground">
                {allBadgeLabels.length === 0 ? (
                  <>
                    <p>{t('concept_mapping.source_id_empty_no_badges')}</p>
                    <p className="mt-0.5">{t('concept_mapping.source_id_empty_no_badges_hint')}</p>
                  </>
                ) : (
                  t('concept_mapping.source_id_empty')
                )}
              </div>
            </Card>
          ) : (
            <div className="space-y-2">
              {ranges.map((range) => {
                const edit = edits[range.badgeLabel]
                const err = errors[range.badgeLabel]
                const capacity = range.rangeEnd - range.rangeStart + 1
                const used = clampNextId(range.nextId, range.rangeStart, range.rangeEnd, range.highestOwnId) - range.rangeStart
                const rangePct = Math.round((used / capacity) * 100)
                return (
                  <Card key={range.badgeLabel} className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{range.badgeLabel}</span>
                          <Badge variant="secondary" className="text-[10px]">
                            {range.assignedCount.toLocaleString()} {t('concept_mapping.source_id_assigned')}
                          </Badge>
                          {used > 0 && (
                            <span className="flex items-center gap-1.5" title={t('concept_mapping.source_id_range_usage', {
                              used: used.toLocaleString(),
                              capacity: capacity.toLocaleString(),
                            })}>
                              <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                                {/* A nearly-empty range still shows a sliver: 0.02% of a
                                    2M band is real usage, and a bar of width 0 reads as
                                    "nothing assigned". */}
                                <span
                                  className={cn('block h-full rounded-full', rangePct >= 90 ? 'bg-amber-500' : 'bg-primary')}
                                  style={{ width: `${Math.max(2, Math.min(100, (used / capacity) * 100))}%` }}
                                />
                              </span>
                              <span className="text-[10px] tabular-nums text-muted-foreground">
                                {rangePct > 0 ? `${rangePct}%` : '<1%'}
                              </span>
                            </span>
                          )}
                        </div>

                        {edit ? (() => {
                          // Validated as they type: the message names what is wrong
                          // with the bounds right under them, and the capacity says
                          // how many ids the range would hold before it is saved.
                          const liveError = validateRange(range.badgeLabel, edit)
                          const capacity = rangeCapacity(parseRangeBound(edit.rangeStart), parseRangeBound(edit.rangeEnd))
                          const cancelEdit = () => setEdits((prev) => { const n = { ...prev }; delete n[range.badgeLabel]; return n })
                          // Enter saves from either bound, Escape backs out: the two
                          // inputs read as one field, and reaching for the button to
                          // commit a number you just typed breaks that.
                          const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
                            if (e.key === 'Enter' && canWrite && !liveError) {
                              e.preventDefault()
                              void saveEdit(range.badgeLabel)
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              cancelEdit()
                            }
                          }
                          return (
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <Input
                                className={cn('h-7 w-36 font-mono text-xs', liveError && 'border-destructive focus-visible:ring-destructive')}
                                inputMode="numeric"
                                value={formatRangeBound(edit.rangeStart)}
                                onChange={(e) => setEdits((prev) => ({ ...prev, [range.badgeLabel]: { ...edit, rangeStart: e.target.value } }))}
                                onKeyDown={onKeyDown}
                              />
                              <span className="text-xs text-muted-foreground">→</span>
                              <Input
                                className={cn('h-7 w-36 font-mono text-xs', liveError && 'border-destructive focus-visible:ring-destructive')}
                                inputMode="numeric"
                                value={formatRangeBound(edit.rangeEnd)}
                                onChange={(e) => setEdits((prev) => ({ ...prev, [range.badgeLabel]: { ...edit, rangeEnd: e.target.value } }))}
                                onKeyDown={onKeyDown}
                              />
                              <Button size="sm" className="h-7 text-xs" disabled={!canWrite || !!liveError} onClick={() => saveEdit(range.badgeLabel)}>{t('common.save')}</Button>
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={cancelEdit}>{t('common.cancel')}</Button>
                            </div>
                            {liveError
                              ? <p className="text-[11px] text-destructive">{liveError}</p>
                              : capacity != null && (
                                  <p className="text-[11px] text-muted-foreground tabular-nums">
                                    {t('concept_mapping.source_id_capacity', { count: capacity, formatted: formatNumber(capacity) })}
                                  </p>
                                )}
                            {err && err !== liveError && <p className="text-[11px] text-destructive">{err}</p>}
                          </div>
                          )
                        })() : (
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">
                              {formatNumber(range.rangeStart)} → {formatNumber(range.rangeEnd)}
                            </span>
                            {canWrite && (
                            <button
                              className="text-[11px] text-primary underline-offset-2 hover:underline"
                              onClick={() => setEdits((prev) => ({ ...prev, [range.badgeLabel]: { rangeStart: String(range.rangeStart), rangeEnd: String(range.rangeEnd) } }))}
                            >
                              {t('common.edit')}
                            </button>
                            )}
                          </div>
                        )}
                        {assignProgress && assignProgress.badge === range.badgeLabel && (
                          <p className="text-[11px] text-muted-foreground tabular-nums">
                            {t('concept_mapping.source_id_assign_progress', {
                              done: assignProgress.done.toLocaleString(),
                              total: assignProgress.total.toLocaleString(),
                            } as Record<string, string>)}
                          </p>
                        )}
                        {!assignProgress && assignResult && assignResult.badge === range.badgeLabel && (
                          <p className={`text-[11px] ${assignResult.exhausted ? 'text-amber-600 dark:text-amber-400' : assignResult.newlyAssigned > 0 ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}>
                            {assignResult.exhausted
                              ? t('concept_mapping.source_id_assign_exhausted', { count: assignResult.newlyAssigned.toLocaleString(), total: assignResult.total.toLocaleString() } as Record<string, string>)
                              : assignResult.total === 0
                                ? t('concept_mapping.source_id_assign_no_concepts')
                                : assignResult.newlyAssigned === 0
                                  ? t('concept_mapping.source_id_assign_all_done', { total: assignResult.total.toLocaleString() })
                                  : t('concept_mapping.source_id_assign_result', { count: assignResult.newlyAssigned.toLocaleString(), total: assignResult.total.toLocaleString() } as Record<string, string>)}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 text-xs"
                          disabled={assignLoading === range.badgeLabel || !canWrite}
                          onClick={() => assignIds(range.badgeLabel)}
                        >
                          {assignLoading === range.badgeLabel ? (
                            <span className="animate-spin">↻</span>
                          ) : (
                            <Hash size={12} />
                          )}
                          {t('concept_mapping.source_id_assign')}
                        </Button>
                        {range.assignedCount > 0 && (
                          <Button size="icon-sm" variant="ghost" disabled={!canWrite} className="h-7 w-7 text-muted-foreground" title={t('concept_mapping.source_id_reset')} onClick={() => setResetConfirm(range.badgeLabel)}>
                            <RefreshCw size={12} />
                          </Button>
                        )}
                        <Button size="icon-sm" variant="ghost" disabled={!canWrite} className="h-7 w-7 text-destructive hover:text-destructive" title={t('common.remove')} onClick={() => setDeleteConfirm(range.badgeLabel)}>
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </div>
                  </Card>
                )
              })}
            </div>
          )}
        </div>

        {/* Add badge */}
        {canWrite && unregisteredBadges.length > 0 && (
          <Card className="p-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{t('concept_mapping.source_id_add_badge')}</p>
            <div className="flex flex-wrap gap-2">
              {unregisteredBadges.map((label) => (
                <button
                  key={label}
                  className="flex items-center gap-1 rounded-full border border-dashed px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                  onClick={() => addBadge(label)}
                >
                  <Plus size={11} />
                  {label}
                </button>
              ))}
            </div>
          </Card>
        )}

      </div>

      {/* Reset confirmation */}
      <AlertDialog open={!!resetConfirm} onOpenChange={(open) => { if (!open) setResetConfirm(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.source_id_reset_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {resetConfirm === 'all'
                ? t('concept_mapping.source_id_reset_all_confirm_desc')
                : t('concept_mapping.source_id_reset_confirm_desc', { badge: resetConfirm })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (resetConfirm === 'all') resetAll()
                else if (resetConfirm) resetBadge(resetConfirm)
              }}
            >
              {t('concept_mapping.source_id_reset_confirm_action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.source_id_delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.source_id_delete_confirm_desc', { badge: deleteConfirm })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => { if (deleteConfirm) removeBadge(deleteConfirm) }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
