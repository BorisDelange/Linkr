import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, RefreshCw, Hash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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
import type { MappingProject, SourceConceptIdRange } from '@/types'

// OMOP convention: custom source concept IDs start at 2,000,000,001
// Max safe value: 2,147,483,647 (INT32 max, for compatibility with INTEGER columns)
const OMOP_CUSTOM_MIN = 2_000_000_001
const OMOP_CUSTOM_MAX = 2_147_483_647
const DEFAULT_RANGE_SIZE = 10_000_000

interface SourceIdTabProps {
  workspaceId: string
  projects: MappingProject[]
  allMappings: { sourceConceptCode: string; sourceVocabularyId: string; projectId: string }[]
}

interface RangeRow extends SourceConceptIdRange {
  /** id field added by storage layer */
  id: string
  assignedCount: number
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

export function SourceIdTab({ workspaceId, projects, allMappings }: SourceIdTabProps) {
  const { t } = useTranslation()

  const [ranges, setRanges] = useState<RangeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [edits, setEdits] = useState<Record<string, RangeEdit>>({})
  const [assignLoading, setAssignLoading] = useState<string | null>(null)
  const [resetConfirm, setResetConfirm] = useState<string | null>(null) // badgeLabel or 'all'
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Distinct badge labels across all projects
  const allBadgeLabels: string[] = Array.from(
    new Set(projects.flatMap((p) => (p.badges ?? []).map((b) => b.label).filter(Boolean))),
  ).sort()

  const load = useCallback(async () => {
    setLoading(true)
    const stored = await getStorage().sourceConceptIdRanges.getByWorkspace(workspaceId)
    // Compute assigned counts per badge
    const rows: RangeRow[] = await Promise.all(
      stored.map(async (r) => {
        const entries = await getStorage().sourceConceptIdEntries.getByWorkspaceAndBadge(workspaceId, r.badgeLabel)
        return { ...r, id: `${workspaceId}__${r.badgeLabel}`, assignedCount: entries.length }
      }),
    )
    setRanges(rows.sort((a, b) => a.rangeStart - b.rangeStart))
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

  const saveEdit = async (badgeLabel: string) => {
    const edit = edits[badgeLabel]
    if (!edit) return
    const start = parseInt(edit.rangeStart, 10)
    const end = parseInt(edit.rangeEnd, 10)
    const newErrors: Record<string, string> = { ...errors }

    if (isNaN(start) || isNaN(end)) {
      newErrors[badgeLabel] = t('concept_mapping.source_id_error_invalid')
      setErrors(newErrors)
      return
    }
    if (start < OMOP_CUSTOM_MIN) {
      newErrors[badgeLabel] = t('concept_mapping.source_id_error_min', { min: formatNumber(OMOP_CUSTOM_MIN) })
      setErrors(newErrors)
      return
    }
    if (end > OMOP_CUSTOM_MAX) {
      newErrors[badgeLabel] = t('concept_mapping.source_id_error_max', { max: formatNumber(OMOP_CUSTOM_MAX) })
      setErrors(newErrors)
      return
    }
    if (end <= start) {
      newErrors[badgeLabel] = t('concept_mapping.source_id_error_order')
      setErrors(newErrors)
      return
    }
    if (rangeOverlaps(ranges, badgeLabel, start, end)) {
      newErrors[badgeLabel] = t('concept_mapping.source_id_error_overlap')
      setErrors(newErrors)
      return
    }

    delete newErrors[badgeLabel]
    setErrors(newErrors)

    const existing = ranges.find((r) => r.badgeLabel === badgeLabel)
    if (!existing) return
    const now = new Date().toISOString()
    await getStorage().sourceConceptIdRanges.save({ ...existing, rangeStart: start, rangeEnd: end, updatedAt: now })
    setEdits((prev) => { const n = { ...prev }; delete n[badgeLabel]; return n })
    await load()
  }

  const assignIds = async (badgeLabel: string) => {
    setAssignLoading(badgeLabel)
    try {
      const range = ranges.find((r) => r.badgeLabel === badgeLabel)
      if (!range) return

      // Gather all (vocabularyId, conceptCode) pairs from projects that have this badge
      const projectsWithBadge = projects.filter((p) =>
        (p.badges ?? []).some((b) => b.label === badgeLabel),
      )
      const projectIds = new Set(projectsWithBadge.map((p) => p.id))

      // Unique (vocabularyId, conceptCode) pairs — exclude file projects that already have a real conceptIdColumn
      // Database projects and file projects without conceptIdColumn both get assigned custom IDs
      const pairsToAssign = new Set<string>()
      for (const m of allMappings) {
        if (!projectIds.has(m.projectId)) continue
        const proj = projects.find((p) => p.id === m.projectId)
        if (proj?.sourceType === 'file' && proj.fileSourceData?.columnMapping?.conceptIdColumn) continue
        if (m.sourceVocabularyId && m.sourceConceptCode) {
          pairsToAssign.add(`${m.sourceVocabularyId}__${m.sourceConceptCode}`)
        }
      }

      // Load existing entries for this badge
      const existing = await getStorage().sourceConceptIdEntries.getByWorkspaceAndBadge(workspaceId, badgeLabel)
      const existingMap = new Map(existing.map((e) => [`${e.vocabularyId}__${e.conceptCode}`, e]))

      let nextId = range.nextId
      const now = new Date().toISOString()
      let assigned = 0

      for (const pairKey of pairsToAssign) {
        if (existingMap.has(pairKey)) continue // already assigned
        if (nextId > range.rangeEnd) break // range exhausted

        const [vocabularyId, conceptCode] = pairKey.split('__')
        const entryId = `${workspaceId}__${badgeLabel}__${vocabularyId}__${conceptCode}`
        await getStorage().sourceConceptIdEntries.save({
          id: entryId,
          workspaceId,
          badgeLabel,
          vocabularyId,
          conceptCode,
          sourceConceptId: nextId,
          createdAt: now,
        })
        nextId++
        assigned++
      }

      if (assigned > 0) {
        await getStorage().sourceConceptIdRanges.save({ ...range, nextId, updatedAt: now })
      }
      await load()
    } finally {
      setAssignLoading(null)
    }
  }

  const resetBadge = async (badgeLabel: string) => {
    await getStorage().sourceConceptIdEntries.deleteByWorkspaceAndBadge(workspaceId, badgeLabel)
    const range = ranges.find((r) => r.badgeLabel === badgeLabel)
    if (range) {
      await getStorage().sourceConceptIdRanges.save({ ...range, nextId: range.rangeStart, updatedAt: new Date().toISOString() })
    }
    setResetConfirm(null)
    await load()
  }

  const resetAll = async () => {
    await getStorage().sourceConceptIdEntries.deleteByWorkspace(workspaceId)
    for (const range of ranges) {
      await getStorage().sourceConceptIdRanges.save({ ...range, nextId: range.rangeStart, updatedAt: new Date().toISOString() })
    }
    setResetConfirm(null)
    await load()
  }

  const removeBadge = async (badgeLabel: string) => {
    await getStorage().sourceConceptIdEntries.deleteByWorkspaceAndBadge(workspaceId, badgeLabel)
    await getStorage().sourceConceptIdRanges.delete(workspaceId, badgeLabel)
    await load()
  }

  const unregisteredBadges = allBadgeLabels.filter((l) => !ranges.some((r) => r.badgeLabel === l))

  const totalAssigned = ranges.reduce((s, r) => s + r.assignedCount, 0)

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-3xl space-y-5">

        {/* Header info */}
        <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <Hash size={12} className="shrink-0" />
          <span>{t('concept_mapping.source_id_info')}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px]">
            {formatNumber(OMOP_CUSTOM_MIN)}–{formatNumber(OMOP_CUSTOM_MAX)}
          </span>
        </div>

        {/* Badge ranges */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{t('concept_mapping.source_id_ranges')}</p>
            {totalAssigned > 0 && (
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-destructive hover:text-destructive" onClick={() => setResetConfirm('all')}>
                <RefreshCw size={12} />
                {t('concept_mapping.source_id_reset_all')}
              </Button>
            )}
          </div>

          {loading ? (
            <div className="py-8 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
          ) : ranges.length === 0 ? (
            <Card>
              <div className="py-8 text-center text-xs text-muted-foreground">{t('concept_mapping.source_id_empty')}</div>
            </Card>
          ) : (
            <div className="space-y-2">
              {ranges.map((range) => {
                const edit = edits[range.badgeLabel]
                const err = errors[range.badgeLabel]
                const capacity = range.rangeEnd - range.rangeStart + 1
                const used = range.nextId - range.rangeStart
                const pct = Math.round((used / capacity) * 100)
                return (
                  <Card key={range.badgeLabel} className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{range.badgeLabel}</span>
                          <Badge variant="secondary" className="text-[10px]">
                            {range.assignedCount.toLocaleString()} {t('concept_mapping.source_id_assigned')}
                          </Badge>
                          {used > 0 && pct > 0 && (
                            <span className="text-[10px] text-muted-foreground">{pct}% {t('concept_mapping.source_id_used')}</span>
                          )}
                        </div>

                        {edit ? (
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <Input
                                className="h-7 w-36 font-mono text-xs"
                                value={edit.rangeStart}
                                onChange={(e) => setEdits((prev) => ({ ...prev, [range.badgeLabel]: { ...edit, rangeStart: e.target.value } }))}
                              />
                              <span className="text-xs text-muted-foreground">→</span>
                              <Input
                                className="h-7 w-36 font-mono text-xs"
                                value={edit.rangeEnd}
                                onChange={(e) => setEdits((prev) => ({ ...prev, [range.badgeLabel]: { ...edit, rangeEnd: e.target.value } }))}
                              />
                              <Button size="sm" className="h-7 text-xs" onClick={() => saveEdit(range.badgeLabel)}>{t('common.save')}</Button>
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEdits((prev) => { const n = { ...prev }; delete n[range.badgeLabel]; return n })}>{t('common.cancel')}</Button>
                            </div>
                            {err && <p className="text-[11px] text-destructive">{err}</p>}
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">
                              {formatNumber(range.rangeStart)} → {formatNumber(range.rangeEnd)}
                            </span>
                            <button
                              className="text-[11px] text-primary underline-offset-2 hover:underline"
                              onClick={() => setEdits((prev) => ({ ...prev, [range.badgeLabel]: { rangeStart: String(range.rangeStart), rangeEnd: String(range.rangeEnd) } }))}
                            >
                              {t('common.edit')}
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 text-xs"
                          disabled={assignLoading === range.badgeLabel}
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
                          <Button size="icon-sm" variant="ghost" className="h-7 w-7 text-muted-foreground" title={t('concept_mapping.source_id_reset')} onClick={() => setResetConfirm(range.badgeLabel)}>
                            <RefreshCw size={12} />
                          </Button>
                        )}
                        <Button size="icon-sm" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" title={t('common.remove')} onClick={() => removeBadge(range.badgeLabel)}>
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
        {unregisteredBadges.length > 0 && (
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
    </div>
  )
}
