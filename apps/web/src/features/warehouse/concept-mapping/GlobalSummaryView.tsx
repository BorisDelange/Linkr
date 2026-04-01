import { useState, useMemo, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, LayoutGrid, Settings2, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { getStorage } from '@/lib/storage'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { ConceptMapping, MappingProject, MappingStatus } from '@/types'

interface GlobalSummaryViewProps {
  onBack: () => void
}

const STATUS_COLORS: Record<MappingStatus, string> = {
  unchecked: '#9ca3af',
  approved: '#34d399',
  rejected: '#ef4444',
  flagged: '#fb923c',
  invalid: '#f87171',
  ignored: '#d1d5db',
}

const STATUS_BAR_COLORS: Record<string, string> = {
  approved: '#34d399',
  flagged: '#fb923c',
  rejected: '#ef4444',
  unchecked: '#9ca3af',
  ignored: '#d1d5db',
}

const STATUS_BADGE: Record<string, string> = {
  unchecked: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  flagged: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400',
  ignored: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
}

const EQUIV_BADGE: Record<string, { label: string; className: string }> = {
  'skos:exactMatch':   { label: 'Exact',   className: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400' },
  'skos:closeMatch':   { label: 'Close',   className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' },
  'skos:broadMatch':   { label: 'Broad',   className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400' },
  'skos:narrowMatch':  { label: 'Narrow',  className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400' },
  'skos:relatedMatch': { label: 'Related', className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
}

const PAGE_SIZE = 50
const TOP_N = 10
const FILTER_INPUT_CLASS = 'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

interface GroupStat {
  totalMappings: number
  approved: number
  flagged: number
  rejected: number
  unchecked: number
  ignored: number
  projectCount: number
  projectIds: Set<string>
}

/** Returns a label → stat map, with items beyond TOP_N merged into "__other__". */
function effectiveStatus(m: ConceptMapping): MappingStatus {
  const reviews = m.reviews ?? []
  if (reviews.length === 0) return m.status
  const counts = { approved: 0, rejected: 0, flagged: 0, ignored: 0, unchecked: 0, invalid: 0 }
  for (const r of reviews) counts[r.status as MappingStatus] = (counts[r.status as MappingStatus] ?? 0) + 1
  const max = Math.max(...Object.values(counts))
  if (counts.approved === max) return 'approved'
  if (counts.rejected === max) return 'rejected'
  if (counts.flagged === max) return 'flagged'
  return m.status
}

function computeGroupStats(
  mappings: ConceptMapping[],
  projects: MappingProject[],
  groupMode: 'project' | 'badge' | 'status',
): Map<string, GroupStat> {
  const raw = new Map<string, GroupStat>()

  const ensure = (name: string) => {
    if (!raw.has(name)) {
      raw.set(name, { totalMappings: 0, approved: 0, flagged: 0, rejected: 0, unchecked: 0, ignored: 0, projectCount: 0, projectIds: new Set() })
    }
    return raw.get(name)!
  }

  const projectMap = new Map(projects.map((p) => [p.id, p]))

  for (const m of mappings) {
    const p = projectMap.get(m.projectId)
    let keys: string[]
    if (groupMode === 'project') {
      keys = p ? [p.name] : []
    } else if (groupMode === 'badge') {
      const labels = (p?.badges ?? []).map((b) => b.label).filter(Boolean)
      keys = labels.length > 0 ? labels : ['Other']
    } else {
      keys = [effectiveStatus(m)]
    }
    const eff = effectiveStatus(m)
    for (const key of keys) {
      const g = ensure(key)
      g.totalMappings++
      g.projectIds.add(m.projectId)
      if (eff === 'approved') g.approved++
      else if (eff === 'flagged') g.flagged++
      else if (eff === 'rejected') g.rejected++
      else if (eff === 'ignored') g.ignored++
      else g.unchecked++
    }
  }

  for (const [, g] of raw) g.projectCount = g.projectIds.size

  const sorted = Array.from(raw.entries()).sort((a, b) => b[1].totalMappings - a[1].totalMappings)
  if (sorted.length <= TOP_N) return raw

  const top = sorted.slice(0, TOP_N)
  const rest = sorted.slice(TOP_N)

  const other: GroupStat = { totalMappings: 0, approved: 0, flagged: 0, rejected: 0, unchecked: 0, ignored: 0, projectCount: 0, projectIds: new Set() }
  for (const [, g] of rest) {
    other.totalMappings += g.totalMappings
    other.approved += g.approved
    other.flagged += g.flagged
    other.rejected += g.rejected
    other.unchecked += g.unchecked
    other.ignored += g.ignored
    for (const id of g.projectIds) other.projectIds.add(id)
  }
  other.projectCount = other.projectIds.size

  const result = new Map(top)
  result.set('__other__', other)
  return result
}

/** Small dropdown filter for categorical columns. */
function ColFilterSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string | null
  options: { value: string; label: string }[]
  placeholder: string
  onChange: (v: string | null) => void
}) {
  const { t } = useTranslation()
  const selectedLabel = options.find((o) => o.value === value)?.label ?? value
  return (
    <Select value={value ?? '__all__'} onValueChange={(v) => onChange(v === '__all__' ? null : v)}>
      <SelectTrigger className="h-6 w-full border-dashed text-[10px] font-normal">
        <SelectValue placeholder={placeholder}>
          {value ? selectedLabel : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">{t('concepts.filter_all')}</SelectItem>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className="text-xs">{opt.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Multi-select dropdown filter for the group column. */
function MultiSelectFilter({
  selected,
  options,
  onChange,
}: {
  selected: Set<string>
  options: { value: string; label: string }[]
  onChange: (v: Set<string>) => void
}) {
  const { t } = useTranslation()
  const allSelected = selected.size === 0
  const label = allSelected
    ? t('concepts.filter_all')
    : selected.size === 1
      ? (options.find((o) => o.value === [...selected][0])?.label ?? [...selected][0])
      : `${selected.size} selected`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={`flex h-6 w-full items-center justify-between rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none hover:border-primary ${!allSelected ? 'border-primary text-primary' : 'text-muted-foreground'}`}
        >
          <span className="truncate">{label}</span>
          <span className="ml-1 shrink-0 opacity-50">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-60 overflow-auto">
        <DropdownMenuCheckboxItem
          checked={allSelected}
          onCheckedChange={() => onChange(new Set())}
          onSelect={(e) => e.preventDefault()}
          className="text-xs"
        >
          {t('concepts.filter_all')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.value}
            checked={selected.has(opt.value)}
            onCheckedChange={(checked) => {
              const next = new Set(selected)
              if (checked) next.add(opt.value)
              else next.delete(opt.value)
              onChange(next)
            }}
            onSelect={(e) => e.preventDefault()}
            className="text-xs"
          >
            {opt.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Row for project/status mode: one row per mapping
interface GlobalMappingRow extends ConceptMapping {
  projectName: string
}

// Row for badge mode: deduplicated by (sourceConceptCode, targetConceptId), votes aggregated
interface DeduplicatedMappingRow {
  key: string
  sourceVocabularyId: string
  sourceConceptName: string
  sourceConceptCode: string
  targetVocabularyId: string
  targetConceptName: string
  targetConceptId: number
  equivalence?: string
  votesApproved: number
  votesFlagged: number
  votesRejected: number
  projectCount: number
  badgeLabels: string[]
}

interface GlobalTableFilters {
  groupLabels?: Set<string>  // multi-select: badge labels, project names, or statuses
  sourceVocabularyId?: string | null
  sourceConceptCode?: string
  sourceConceptName?: string
  targetVocabularyId?: string | null
  targetConceptId?: string
  targetConceptName?: string
  equivalence?: string | null
}

export function GlobalSummaryView({ onBack }: GlobalSummaryViewProps) {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { mappingProjects, mappingProjectsLoaded, loadMappingProjects } = useConceptMappingStore()

  const [allMappings, setAllMappings] = useState<ConceptMapping[]>([])
  const [loadingMappings, setLoadingMappings] = useState(true)
  const [groupMode, setGroupMode] = useState<'project' | 'badge' | 'status'>('project')
  const [activeTab, setActiveTab] = useState('summary')
  const [page, setPage] = useState(0)
  const [sorting, setSorting] = useState<{ columnId: string; desc: boolean } | null>(null)
  const [colFilters, setColFilters] = useState<GlobalTableFilters>({})
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})

  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
  }, [mappingProjectsLoaded, loadMappingProjects])

  const projects = useMemo(
    () => activeWorkspaceId ? mappingProjects.filter((p) => p.workspaceId === activeWorkspaceId) : [],
    [mappingProjects, activeWorkspaceId],
  )

  const loadAllMappings = useCallback(async () => {
    if (projects.length === 0) { setLoadingMappings(false); return }
    setLoadingMappings(true)
    const results: ConceptMapping[] = []
    for (const p of projects) {
      const ms = await getStorage().conceptMappings.getByProject(p.id)
      results.push(...ms)
    }
    setAllMappings(results)
    setLoadingMappings(false)
  }, [projects])

  useEffect(() => { loadAllMappings() }, [loadAllMappings])

  const groupStats = useMemo(
    () => computeGroupStats(allMappings, projects, groupMode),
    [allMappings, projects, groupMode],
  )

  const groupNames = useMemo(() => {
    const keys = Array.from(groupStats.keys())
    return [...keys.filter((k) => k !== '__other__'), ...keys.filter((k) => k === '__other__')]
  }, [groupStats])

  const getDisplayName = useCallback((key: string) => {
    if (key === '__other__') return 'Other'
    if (groupMode === 'status') return t(`concept_mapping.status_${key}`)
    return key
  }, [groupMode, t])

  const totals = useMemo(() => {
    let total = 0, approved = 0, flagged = 0, rejected = 0, unchecked = 0, ignored = 0
    for (const g of groupStats.values()) {
      total += g.totalMappings
      approved += g.approved
      flagged += g.flagged
      rejected += g.rejected
      unchecked += g.unchecked
      ignored += g.ignored
    }
    return { total, approved, flagged, rejected, unchecked, ignored }
  }, [groupStats])

  const chartData = useMemo(() => groupNames.map((name) => {
    const g = groupStats.get(name)!
    const displayName = getDisplayName(name)
    return {
      name: displayName.length > 20 ? displayName.slice(0, 18) + '…' : displayName,
      approved: g.approved, flagged: g.flagged, rejected: g.rejected,
      unchecked: g.unchecked, ignored: g.ignored,
    }
  }), [groupNames, groupStats, getDisplayName])

  // ── Table tab ────────────────────────────────────────────────────────
  const tableProjectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  // badge mode: deduplicate by (sourceConceptCode||sourceConceptId, targetConceptId, effectiveBadges)
  // When a badge filter is active, only show the filtered badges and group on those only
  const deduplicatedRows = useMemo<DeduplicatedMappingRow[]>(() => {
    if (groupMode !== 'badge') return []
    const activeFilter = colFilters.groupLabels?.size ? colFilters.groupLabels : null
    const map = new Map<string, DeduplicatedMappingRow>()
    for (const m of allMappings) {
      const p = tableProjectMap.get(m.projectId)
      const allBadges = (p?.badges ?? []).map((b) => b.label).filter(Boolean)
      // If filter active, restrict to filtered badges; skip mapping if project has none
      const effectiveBadges = activeFilter
        ? allBadges.filter((b) => activeFilter.has(b))
        : allBadges
      if (activeFilter && effectiveBadges.length === 0) continue
      // Key includes effective badges so grouping is consistent with what's displayed
      const badgeKey = [...effectiveBadges].sort().join('|')
      const key = `${m.sourceConceptCode ?? m.sourceConceptId}__${m.targetConceptId}__${badgeKey}`
      if (!map.has(key)) {
        map.set(key, {
          key,
          sourceVocabularyId: m.sourceVocabularyId ?? '',
          sourceConceptName: m.sourceConceptName,
          sourceConceptCode: m.sourceConceptCode ?? String(m.sourceConceptId),
          targetVocabularyId: m.targetVocabularyId ?? '',
          targetConceptName: m.targetConceptName ?? '',
          targetConceptId: m.targetConceptId,
          equivalence: m.equivalence,
          votesApproved: 0,
          votesFlagged: 0,
          votesRejected: 0,
          projectCount: 0,
          badgeLabels: effectiveBadges,
        })
      }
      const row = map.get(key)!
      const reviews = m.reviews ?? []
      row.votesApproved += reviews.filter((r) => r.status === 'approved').length
      row.votesFlagged += reviews.filter((r) => r.status === 'flagged').length
      row.votesRejected += reviews.filter((r) => r.status === 'rejected').length
      row.projectCount++
    }
    return Array.from(map.values())
  }, [allMappings, tableProjectMap, groupMode, colFilters.groupLabels])

  // project/status mode: one row per mapping
  const flatRows = useMemo<GlobalMappingRow[]>(() => {
    if (groupMode === 'badge') return []
    return allMappings.map((m) => ({
      ...m,
      projectName: tableProjectMap.get(m.projectId)?.name ?? m.projectId,
    }))
  }, [allMappings, tableProjectMap, groupMode])

  const allEquivs = useMemo(() => {
    const vals = groupMode === 'badge'
      ? deduplicatedRows.map((r) => r.equivalence)
      : flatRows.map((r) => r.equivalence)
    return [...new Set(vals.filter(Boolean) as string[])].sort()
  }, [groupMode, deduplicatedRows, flatRows])

  const allStatuses = useMemo(() =>
    [...new Set(flatRows.map((r) => r.status).filter(Boolean))].sort(),
    [flatRows],
  )

  const allBadgeLabels = useMemo(() => {
    const labels = new Set<string>()
    for (const p of projects) for (const b of p.badges ?? []) if (b.label) labels.add(b.label)
    return Array.from(labels).sort()
  }, [projects])

  const allSourceVocabs = useMemo(() => {
    const vals = groupMode === 'badge'
      ? deduplicatedRows.map((r) => r.sourceVocabularyId)
      : flatRows.map((r) => r.sourceVocabularyId)
    return [...new Set(vals.filter(Boolean))].sort()
  }, [groupMode, deduplicatedRows, flatRows])

  const allTargetVocabs = useMemo(() => {
    const vals = groupMode === 'badge'
      ? deduplicatedRows.map((r) => r.targetVocabularyId)
      : flatRows.map((r) => r.targetVocabularyId)
    return [...new Set(vals.filter(Boolean))].sort()
  }, [groupMode, deduplicatedRows, flatRows])

  // Filters
  const filteredDeduped = useMemo(() => {
    const f = colFilters
    // groupLabels already applied during deduplication — only apply text/equiv filters here
    return deduplicatedRows.filter((r) => {
      if (f.sourceVocabularyId && r.sourceVocabularyId !== f.sourceVocabularyId) return false
      if (f.sourceConceptCode && !r.sourceConceptCode.toLowerCase().includes(f.sourceConceptCode.toLowerCase())) return false
      if (f.sourceConceptName && !r.sourceConceptName.toLowerCase().includes(f.sourceConceptName.toLowerCase())) return false
      if (f.equivalence && r.equivalence !== f.equivalence) return false
      if (f.targetVocabularyId && r.targetVocabularyId !== f.targetVocabularyId) return false
      if (f.targetConceptId && !String(r.targetConceptId).includes(f.targetConceptId)) return false
      if (f.targetConceptName && !r.targetConceptName.toLowerCase().includes(f.targetConceptName.toLowerCase())) return false
      return true
    })
  }, [deduplicatedRows, colFilters])

  const filteredFlat = useMemo(() => {
    const f = colFilters
    return flatRows.filter((r) => {
      if (f.groupLabels?.size && !f.groupLabels.has(groupMode === 'status' ? r.status : r.projectName)) return false
      if (f.sourceVocabularyId && r.sourceVocabularyId !== f.sourceVocabularyId) return false
      if (f.sourceConceptCode && !(r.sourceConceptCode ?? '').toLowerCase().includes(f.sourceConceptCode.toLowerCase())) return false
      if (f.sourceConceptName && !r.sourceConceptName.toLowerCase().includes(f.sourceConceptName.toLowerCase())) return false
      if (f.equivalence && r.equivalence !== f.equivalence) return false
      if (f.targetVocabularyId && r.targetVocabularyId !== f.targetVocabularyId) return false
      if (f.targetConceptId && !String(r.targetConceptId).includes(f.targetConceptId)) return false
      if (f.targetConceptName && !(r.targetConceptName ?? '').toLowerCase().includes(f.targetConceptName.toLowerCase())) return false
      return true
    })
  }, [flatRows, colFilters, groupMode])

  const handleSort = (columnId: string) => {
    if (sorting?.columnId === columnId) {
      if (sorting.desc) setSorting({ columnId, desc: false })
      else setSorting(null)
    } else {
      setSorting({ columnId, desc: true })
    }
    setPage(0)
  }

  const updateFilter = (key: keyof GlobalTableFilters, value: string | null | Set<string>) => {
    setColFilters((prev) => ({ ...prev, [key]: value ?? undefined }))
    setPage(0)
  }

  // ── Badge mode columns ──
  const dedupedColumns = useMemo<ColumnDef<DeduplicatedMappingRow>[]>(() => [
    {
      id: 'badgeLabels',
      header: () => t('concept_mapping.global_badge'),
      accessorFn: (r) => r.badgeLabels.join(', '),
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-0.5">
          {row.original.badgeLabels.map((l) => (
            <span key={l} className="rounded-full bg-muted px-1.5 py-0.5 text-[9px]">{l}</span>
          ))}
        </div>
      ),
      size: 120,
    },
    {
      id: 'projectCount',
      header: () => <span title={t('concept_mapping.global_projects')}>#</span>,
      accessorFn: (r) => r.projectCount,
      cell: ({ row }) => (
        <span className={`text-xs font-medium ${row.original.projectCount > 1 ? 'text-amber-500' : 'text-muted-foreground'}`}>
          {row.original.projectCount}
        </span>
      ),
      size: 36,
    },
    {
      id: 'sourceVocabularyId',
      header: () => t('concept_mapping.col_source_vocabulary'),
      accessorFn: (r) => r.sourceVocabularyId,
      cell: ({ row }) => <span className="truncate text-xs text-muted-foreground">{row.original.sourceVocabularyId}</span>,
      size: 90,
    },
    {
      id: 'sourceConceptCode',
      header: () => t('concept_mapping.col_source_concept_code'),
      accessorFn: (r) => r.sourceConceptCode,
      cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.sourceConceptCode}</span>,
      size: 80,
    },
    {
      id: 'sourceConceptName',
      header: () => t('concept_mapping.col_source_concept_name'),
      accessorFn: (r) => r.sourceConceptName,
      cell: ({ row }) => (
        <span className="block max-w-[160px] truncate" title={row.original.sourceConceptName}>
          {row.original.sourceConceptName}
        </span>
      ),
      size: 160,
    },
    {
      id: 'equivalence',
      header: () => t('concept_mapping.col_equiv'),
      accessorFn: (r) => r.equivalence,
      cell: ({ row }) => {
        const badge = EQUIV_BADGE[row.original.equivalence ?? '']
        if (!badge) return <span className="text-[10px] text-muted-foreground">{row.original.equivalence?.replace('skos:', '') ?? ''}</span>
        return <Badge variant="secondary" className={`px-1.5 py-0 text-[9px] ${badge.className}`}>{badge.label}</Badge>
      },
      size: 70,
    },
    {
      id: 'targetVocabularyId',
      header: () => t('concept_mapping.col_target_vocabulary'),
      accessorFn: (r) => r.targetVocabularyId,
      cell: ({ row }) => <span className="truncate text-xs text-muted-foreground">{row.original.targetVocabularyId}</span>,
      size: 90,
    },
    {
      id: 'targetConceptId',
      header: () => t('concept_mapping.col_target_concept_id'),
      accessorFn: (r) => r.targetConceptId,
      cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.targetConceptId}</span>,
      size: 80,
    },
    {
      id: 'targetConceptName',
      header: () => t('concept_mapping.col_target_concept_name'),
      accessorFn: (r) => r.targetConceptName,
      cell: ({ row }) => (
        <span className="block max-w-[160px] truncate" title={row.original.targetConceptName}>
          {row.original.targetConceptName}
        </span>
      ),
      size: 160,
    },
    {
      id: 'votesApproved',
      header: () => <span className="text-green-600">✓</span>,
      accessorFn: (r) => r.votesApproved,
      cell: ({ row }) => row.original.votesApproved > 0
        ? <span className="text-xs font-medium text-green-600">{row.original.votesApproved}</span>
        : <span className="text-xs text-muted-foreground/40">—</span>,
      size: 36,
    },
    {
      id: 'votesFlagged',
      header: () => <span className="text-orange-500">⚑</span>,
      accessorFn: (r) => r.votesFlagged,
      cell: ({ row }) => row.original.votesFlagged > 0
        ? <span className="text-xs font-medium text-orange-500">{row.original.votesFlagged}</span>
        : <span className="text-xs text-muted-foreground/40">—</span>,
      size: 36,
    },
    {
      id: 'votesRejected',
      header: () => <span className="text-red-500">✗</span>,
      accessorFn: (r) => r.votesRejected,
      cell: ({ row }) => row.original.votesRejected > 0
        ? <span className="text-xs font-medium text-red-500">{row.original.votesRejected}</span>
        : <span className="text-xs text-muted-foreground/40">—</span>,
      size: 36,
    },
  ], [t])

  // ── Project/status mode columns ──
  const flatColumns = useMemo<ColumnDef<GlobalMappingRow>[]>(() => [
    {
      id: 'groupLabel',
      header: () => groupMode === 'project' ? t('concept_mapping.global_project_col') : t('concept_mapping.col_status'),
      accessorFn: (r) => groupMode === 'project' ? r.projectName : effectiveStatus(r),
      cell: ({ row }) => {
        const eff = effectiveStatus(row.original)
        return groupMode === 'project'
          ? <span className="truncate text-muted-foreground">{row.original.projectName}</span>
          : <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${STATUS_BADGE[eff] ?? ''}`}>
              <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: STATUS_COLORS[eff] }} />
              {t(`concept_mapping.status_${eff}`)}
            </span>
      },
      size: 130,
    },
    {
      id: 'sourceVocabularyId',
      header: () => t('concept_mapping.col_source_vocabulary'),
      accessorFn: (r) => r.sourceVocabularyId,
      cell: ({ row }) => <span className="truncate text-xs text-muted-foreground">{row.original.sourceVocabularyId}</span>,
      size: 90,
    },
    {
      id: 'sourceConceptCode',
      header: () => t('concept_mapping.col_source_concept_code'),
      accessorFn: (r) => r.sourceConceptCode,
      cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.sourceConceptCode}</span>,
      size: 80,
    },
    {
      id: 'sourceConceptName',
      header: () => t('concept_mapping.col_source_concept_name'),
      accessorFn: (r) => r.sourceConceptName,
      cell: ({ row }) => (
        <span className="block max-w-[160px] truncate" title={row.original.sourceConceptName}>
          {row.original.sourceConceptName}
        </span>
      ),
      size: 160,
    },
    {
      id: 'equivalence',
      header: () => t('concept_mapping.col_equiv'),
      accessorFn: (r) => r.equivalence,
      cell: ({ row }) => {
        const badge = EQUIV_BADGE[row.original.equivalence ?? '']
        if (!badge) return <span className="text-[10px] text-muted-foreground">{row.original.equivalence?.replace('skos:', '') ?? ''}</span>
        return <Badge variant="secondary" className={`px-1.5 py-0 text-[9px] ${badge.className}`}>{badge.label}</Badge>
      },
      size: 70,
    },
    {
      id: 'targetVocabularyId',
      header: () => t('concept_mapping.col_target_vocabulary'),
      accessorFn: (r) => r.targetVocabularyId,
      cell: ({ row }) => <span className="truncate text-xs text-muted-foreground">{row.original.targetVocabularyId}</span>,
      size: 90,
    },
    {
      id: 'targetConceptId',
      header: () => t('concept_mapping.col_target_concept_id'),
      accessorFn: (r) => r.targetConceptId,
      cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.targetConceptId}</span>,
      size: 80,
    },
    {
      id: 'targetConceptName',
      header: () => t('concept_mapping.col_target_concept_name'),
      accessorFn: (r) => r.targetConceptName,
      cell: ({ row }) => (
        <span className="block max-w-[160px] truncate" title={row.original.targetConceptName}>
          {row.original.targetConceptName}
        </span>
      ),
      size: 160,
    },
    {
      id: 'votesApproved',
      header: () => <span className="text-green-600">✓</span>,
      cell: ({ row }) => {
        const count = (row.original.reviews ?? []).filter((r) => r.status === 'approved').length
        return count > 0 ? <span className="text-xs font-medium text-green-600">{count}</span> : <span className="text-xs text-muted-foreground/40">—</span>
      },
      size: 36,
    },
    {
      id: 'votesFlagged',
      header: () => <span className="text-orange-500">⚑</span>,
      cell: ({ row }) => {
        const count = (row.original.reviews ?? []).filter((r) => r.status === 'flagged').length
        return count > 0 ? <span className="text-xs font-medium text-orange-500">{count}</span> : <span className="text-xs text-muted-foreground/40">—</span>
      },
      size: 36,
    },
    {
      id: 'votesRejected',
      header: () => <span className="text-red-500">✗</span>,
      cell: ({ row }) => {
        const count = (row.original.reviews ?? []).filter((r) => r.status === 'rejected').length
        return count > 0 ? <span className="text-xs font-medium text-red-500">{count}</span> : <span className="text-xs text-muted-foreground/40">—</span>
      },
      size: 36,
    },
  ], [t, groupMode])

  // Sort + paginate
  type AnyRow = DeduplicatedMappingRow | GlobalMappingRow
  const activeRows: AnyRow[] = groupMode === 'badge' ? filteredDeduped : filteredFlat
  const sortedRows = useMemo<AnyRow[]>(() => {
    if (!sorting) return activeRows
    const { columnId, desc } = sorting
    const dir = desc ? -1 : 1
    return [...activeRows].sort((a, b) => {
      const av = (a as Record<string, unknown>)[columnId]
      const bv = (b as Record<string, unknown>)[columnId]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv)
      return dir * String(av).localeCompare(String(bv))
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRows, sorting])

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE))
  const pageItems = sortedRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // Active columns depend on groupMode
  const activeColumns = groupMode === 'badge' ? dedupedColumns : flatColumns

  const renderColFilter = (columnId: string) => {
    if (columnId === 'groupLabel' || columnId === 'badgeLabels') {
      const selected = colFilters.groupLabels ?? new Set<string>()
      if (groupMode === 'badge') {
        const opts = allBadgeLabels.map((l) => ({ value: l, label: l }))
        return opts.length > 0
          ? <MultiSelectFilter selected={selected} options={opts} onChange={(v) => updateFilter('groupLabels', v)} />
          : null
      }
      if (groupMode === 'status') {
        const opts = allStatuses.map((s) => ({ value: s, label: t(`concept_mapping.status_${s}`) }))
        return opts.length > 0
          ? <MultiSelectFilter selected={selected} options={opts} onChange={(v) => updateFilter('groupLabels', v)} />
          : null
      }
      // project mode
      const opts = [...new Set(flatRows.map((r) => r.projectName))].sort().map((n) => ({ value: n, label: n }))
      return opts.length > 0
        ? <MultiSelectFilter selected={selected} options={opts} onChange={(v) => updateFilter('groupLabels', v)} />
        : null
    }
    if (columnId === 'sourceVocabularyId' && allSourceVocabs.length > 0) {
      const opts = allSourceVocabs.map((v) => ({ value: v, label: v }))
      return <ColFilterSelect value={colFilters.sourceVocabularyId ?? null} options={opts} placeholder="..." onChange={(v) => updateFilter('sourceVocabularyId', v)} />
    }
    if (columnId === 'sourceConceptCode') return <input className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="..." value={colFilters.sourceConceptCode ?? ''} onChange={(e) => updateFilter('sourceConceptCode', e.target.value || null)} />
    if (columnId === 'sourceConceptName') return <input className={FILTER_INPUT_CLASS} placeholder="..." value={colFilters.sourceConceptName ?? ''} onChange={(e) => updateFilter('sourceConceptName', e.target.value || null)} />
    if (columnId === 'equivalence' && allEquivs.length > 0) {
      const opts = allEquivs.map((e) => ({ value: e, label: EQUIV_BADGE[e]?.label ?? e.replace('skos:', '') }))
      return <ColFilterSelect value={colFilters.equivalence ?? null} options={opts} placeholder="..." onChange={(v) => updateFilter('equivalence', v)} />
    }
    if (columnId === 'targetVocabularyId' && allTargetVocabs.length > 0) {
      const opts = allTargetVocabs.map((v) => ({ value: v, label: v }))
      return <ColFilterSelect value={colFilters.targetVocabularyId ?? null} options={opts} placeholder="..." onChange={(v) => updateFilter('targetVocabularyId', v)} />
    }
    if (columnId === 'targetConceptId') return <input className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="..." value={colFilters.targetConceptId ?? ''} onChange={(e) => updateFilter('targetConceptId', e.target.value || null)} />
    if (columnId === 'targetConceptName') return <input className={FILTER_INPUT_CLASS} placeholder="..." value={colFilters.targetConceptName ?? ''} onChange={(e) => updateFilter('targetConceptName', e.target.value || null)} />
    return null
  }

  const dedupTable = useReactTable({
    data: groupMode === 'badge' ? (pageItems as DeduplicatedMappingRow[]) : [],
    columns: dedupedColumns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: totalPages,
  })

  const flatTable = useReactTable({
    data: groupMode !== 'badge' ? (pageItems as GlobalMappingRow[]) : [],
    columns: flatColumns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: totalPages,
  })

  const activeTable = groupMode === 'badge' ? dedupTable : flatTable

  const tooltipStyle = {
    backgroundColor: 'var(--color-popover)',
    border: '1px solid var(--color-border)',
    borderRadius: 6,
    fontSize: 12,
    color: 'var(--color-popover-foreground)',
  }

  const groupModeLabel = groupMode === 'project'
    ? t('concept_mapping.global_group_by_project')
    : groupMode === 'badge'
      ? t('concept_mapping.global_badge')
      : t('concept_mapping.col_status')

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack}>
          <ArrowLeft size={16} />
        </Button>
        <LayoutGrid size={15} className="text-muted-foreground" />
        <span className="text-sm font-semibold">{t('concept_mapping.global_title')}</span>
        <div className="flex items-center gap-2 ml-4">
          <span className="text-xs text-muted-foreground">{t('concept_mapping.global_group_by')}</span>
          <Select
            value={groupMode}
            onValueChange={(v: 'project' | 'badge' | 'status') => {
              setGroupMode(v)
              setColFilters({})
              setPage(0)
            }}
          >
            <SelectTrigger className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project" className="text-xs">{t('concept_mapping.global_group_by_project')}</SelectItem>
              <SelectItem value="badge" className="text-xs">{t('concept_mapping.global_badge')}</SelectItem>
              <SelectItem value="status" className="text-xs">{t('concept_mapping.col_status')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Badge variant="secondary" className="text-[10px] ml-auto">
          {projects.length} {t('concept_mapping.global_projects')} · {totals.total.toLocaleString()} {t('concept_mapping.global_mappings')}
        </Badge>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 flex-col overflow-hidden">
        <div className="flex justify-center border-b">
          <TabsList className="my-2 w-fit">
            <TabsTrigger value="summary">{t('concept_mapping.global_tab_summary')}</TabsTrigger>
            <TabsTrigger value="table">{t('concept_mapping.global_tab_table')}</TabsTrigger>
          </TabsList>
        </div>

        {/* ── SUMMARY TAB ── */}
        <TabsContent value="summary" className="flex-1 overflow-auto p-4">
          {loadingMappings ? (
            <div className="flex h-40 items-center justify-center">
              <p className="text-xs text-muted-foreground">{t('concept_mapping.global_loading')}</p>
            </div>
          ) : (
            <div className="mx-auto max-w-4xl space-y-6">
              {/* Global big numbers */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {[
                  { label: t('concept_mapping.global_total'), value: totals.total, color: '' },
                  { label: t('concept_mapping.prog_approved'), value: totals.approved, color: 'text-green-600' },
                  { label: t('concept_mapping.prog_flagged'), value: totals.flagged, color: 'text-orange-500' },
                  { label: t('concept_mapping.status_rejected'), value: totals.rejected, color: 'text-red-500' },
                  { label: t('concept_mapping.prog_ignored'), value: totals.ignored, color: 'text-gray-400' },
                ].map(({ label, value, color }) => (
                  <Card key={label} className="p-4 text-center">
                    <p className={`text-2xl font-bold ${color}`}>{value.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">{label}</p>
                  </Card>
                ))}
              </div>

              {/* Stacked bar chart per group */}
              {chartData.length > 0 && (
                <Card className="p-4">
                  <p className="mb-3 text-sm font-medium">{t('concept_mapping.global_chart_title')}</p>
                  <ResponsiveContainer width="100%" height={Math.max(220, chartData.length * 36)}>
                    <BarChart data={chartData} layout="vertical" margin={{ left: 120 }}>
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        itemStyle={{ color: 'var(--color-popover-foreground)' }}
                        labelStyle={{ color: 'var(--color-popover-foreground)' }}
                        cursor={{ fill: 'var(--color-accent)' }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {(['approved', 'unchecked', 'flagged', 'rejected', 'ignored'] as const).map((s) => (
                        <Bar key={s} dataKey={s} stackId="a" fill={STATUS_BAR_COLORS[s]} name={t(`concept_mapping.status_${s}`)} radius={s === 'ignored' ? [0, 4, 4, 0] : undefined} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              )}

              {/* Per-group table */}
              <Card className="overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">{groupModeLabel}</TableHead>
                      <TableHead className="text-right text-xs capitalize">{t('concept_mapping.global_projects')}</TableHead>
                      <TableHead className="text-right text-xs capitalize">{t('concept_mapping.global_mappings')}</TableHead>
                      <TableHead className="text-right text-xs">{t('concept_mapping.prog_approved')}</TableHead>
                      <TableHead className="text-right text-xs">{t('concept_mapping.prog_flagged')}</TableHead>
                      <TableHead className="text-right text-xs">{t('concept_mapping.status_rejected')}</TableHead>
                      <TableHead className="text-right text-xs">%</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groupNames.map((name) => {
                      const g = groupStats.get(name)!
                      const pct = g.totalMappings > 0 ? Math.round((g.approved / g.totalMappings) * 100) : 0
                      return (
                        <TableRow key={name} className="text-xs">
                          <TableCell className="font-medium">{getDisplayName(name)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{g.projectCount}</TableCell>
                          <TableCell className="text-right">{g.totalMappings.toLocaleString()}</TableCell>
                          <TableCell className="text-right text-green-600">{g.approved.toLocaleString()}</TableCell>
                          <TableCell className="text-right text-orange-500">{g.flagged.toLocaleString()}</TableCell>
                          <TableCell className="text-right text-red-500">{g.rejected.toLocaleString()}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                                <div className="h-full rounded-full bg-green-500" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-muted-foreground">{pct}%</span>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* ── TABLE TAB ── */}
        <TabsContent value="table" className="flex flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
              <TableHeader>
                <TableRow>
                  {activeTable.getHeaderGroups().map((hg) =>
                    hg.headers.map((header) => {
                      const colId = header.column.id
                      const sortIcon = !sorting || sorting.columnId !== colId
                        ? <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
                        : sorting.desc
                          ? <ArrowDown size={10} className="shrink-0 text-primary" />
                          : <ArrowUp size={10} className="shrink-0 text-primary" />
                      const headerContent = flexRender(header.column.columnDef.header, header.getContext())
                      const rawHeader = typeof header.column.columnDef.header === 'function'
                        ? header.column.columnDef.header(header.getContext())
                        : header.column.columnDef.header
                      const headerTitle = typeof rawHeader === 'string' ? rawHeader : undefined
                      return (
                        <TableHead key={header.id} className="relative select-none overflow-hidden text-xs" style={{ width: header.getSize(), maxWidth: header.getSize() }}>
                          <button type="button" className="flex min-w-0 items-center gap-1 hover:text-foreground" title={headerTitle} onClick={() => handleSort(colId)}>
                            <span className="truncate">{headerContent}</span>
                            {sortIcon}
                          </button>
                        </TableHead>
                      )
                    })
                  )}
                </TableRow>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  {activeTable.getHeaderGroups().map((hg) =>
                    hg.headers.map((header) => (
                      <TableHead key={`f-${header.id}`} className="py-1">
                        {renderColFilter(header.column.id)}
                      </TableHead>
                    ))
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingMappings ? (
                  <TableRow>
                    <TableCell colSpan={activeColumns.length} className="h-24 text-center text-muted-foreground">
                      {t('concept_mapping.global_loading')}
                    </TableCell>
                  </TableRow>
                ) : pageItems.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={activeColumns.length} className="h-24 text-center text-muted-foreground">
                      {t('common.no_results')}
                    </TableCell>
                  </TableRow>
                ) : activeTable.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="truncate">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Footer: settings + pagination */}
          <div className="flex items-center border-t px-4 py-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="h-6 w-6">
                  <Settings2 size={12} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel className="text-xs">{t('common.columns')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {activeTable.getAllColumns().filter((col) => col.getCanHide()).map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.id}
                    className="text-xs"
                    checked={col.getIsVisible()}
                    onCheckedChange={(v) => col.toggleVisibility(v)}
                  >
                    {typeof col.columnDef.header === 'function'
                      ? (col.columnDef.header as () => string)()
                      : String(col.columnDef.header ?? col.id)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <span className="ml-3 text-xs text-muted-foreground">
              {sortedRows.length.toLocaleString()} {t('concept_mapping.global_mappings')}
            </span>

            <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                <ChevronLeft size={14} />
              </Button>
              <span className="text-[10px] text-muted-foreground">{page + 1} / {totalPages}</span>
              <Button variant="ghost" size="icon-sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
