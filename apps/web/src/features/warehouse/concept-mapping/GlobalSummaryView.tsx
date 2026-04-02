import { useState, useMemo, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, LayoutGrid, Settings2, ArrowUpDown, ArrowUp, ArrowDown, Download, FileCode, FileText, FileSpreadsheet } from 'lucide-react'
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
import {
  exportToUsagiCsv,
  exportToSourceToConceptMap,
  exportToSssomTsv,
  exportUnmappedToStcm,
  downloadFile,
} from '@/lib/concept-mapping/export'
import { buildSourceConceptsAllQuery } from '@/lib/concept-mapping/mapping-queries'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { SourceIdTab } from './SourceIdTab'
import type { ConceptMapping, MappingProject, MappingStatus, SourceConceptIdEntry } from '@/types'

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
  unmapped: '#e5e7eb',
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
  /** Unique source concepts (by sourceConceptCode or sourceConceptId) */
  uniqueSourceConcepts: number
  uniqueSourceConceptKeys: Set<string>
  approved: number
  flagged: number
  rejected: number
  unchecked: number
  ignored: number
  /** Total source concepts from project.stats (sum across projects in this group) */
  totalSourceConceptsFromStats: number
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
  groupMode: 'project' | 'badge',
): Map<string, GroupStat> {
  const raw = new Map<string, GroupStat>()

  const ensure = (name: string) => {
    if (!raw.has(name)) {
      raw.set(name, {
        totalMappings: 0,
        uniqueSourceConcepts: 0,
        uniqueSourceConceptKeys: new Set(),
        approved: 0, flagged: 0, rejected: 0, unchecked: 0, ignored: 0,
        totalSourceConceptsFromStats: 0,
        projectCount: 0, projectIds: new Set(),
      })
    }
    return raw.get(name)!
  }

  const projectMap = new Map(projects.map((p) => [p.id, p]))

  // Compute per-project total from stats for the group aggregation
  // We count each project's stats once per group key it belongs to
  const projectStatsCounted = new Set<string>() // `${groupKey}__${projectId}`

  for (const m of mappings) {
    const p = projectMap.get(m.projectId)
    let keys: string[]
    if (groupMode === 'project') {
      keys = p ? [p.name] : []
    } else {
      const labels = (p?.badges ?? []).map((b) => b.label).filter(Boolean)
      keys = labels.length > 0 ? labels : ['Other']
    }
    const eff = effectiveStatus(m)
    const sourceKey = m.sourceConceptCode ?? String(m.sourceConceptId)
    for (const key of keys) {
      const g = ensure(key)
      g.totalMappings++
      g.projectIds.add(m.projectId)
      g.uniqueSourceConceptKeys.add(`${m.projectId}__${sourceKey}`)
      if (eff === 'approved') g.approved++
      else if (eff === 'flagged') g.flagged++
      else if (eff === 'rejected') g.rejected++
      else if (eff === 'ignored') g.ignored++
      else g.unchecked++

      // Add project total once per (groupKey, projectId)
      const statKey = `${key}__${m.projectId}`
      if (!projectStatsCounted.has(statKey)) {
        projectStatsCounted.add(statKey)
        // File projects: use rows.length (accurate); DB projects: stats is 0 (needs DuckDB query)
        const projectTotal = p?.sourceType === 'file'
          ? (p.fileSourceData?.rows.length ?? 0)
          : (p?.stats?.totalSourceConcepts ?? 0)
        g.totalSourceConceptsFromStats += projectTotal
      }
    }
  }

  for (const [, g] of raw) {
    g.projectCount = g.projectIds.size
    g.uniqueSourceConcepts = g.uniqueSourceConceptKeys.size
  }

  const sorted = Array.from(raw.entries()).sort((a, b) => b[1].uniqueSourceConcepts - a[1].uniqueSourceConcepts)
  if (sorted.length <= TOP_N) return raw

  const top = sorted.slice(0, TOP_N)
  const rest = sorted.slice(TOP_N)

  const other: GroupStat = {
    totalMappings: 0, uniqueSourceConcepts: 0, uniqueSourceConceptKeys: new Set(),
    approved: 0, flagged: 0, rejected: 0, unchecked: 0, ignored: 0,
    totalSourceConceptsFromStats: 0, projectCount: 0, projectIds: new Set(),
  }
  for (const [, g] of rest) {
    other.totalMappings += g.totalMappings
    other.uniqueSourceConcepts += g.uniqueSourceConcepts
    other.approved += g.approved
    other.flagged += g.flagged
    other.rejected += g.rejected
    other.unchecked += g.unchecked
    other.ignored += g.ignored
    other.totalSourceConceptsFromStats += g.totalSourceConceptsFromStats
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
  resolvedSourceConceptId: number | undefined
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
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const [allMappings, setAllMappings] = useState<ConceptMapping[]>([])
  const [loadingMappings, setLoadingMappings] = useState(true)
  const [registryEntries, setRegistryEntries] = useState<SourceConceptIdEntry[]>([])
  const [groupMode, setGroupMode] = useState<'project' | 'badge'>('project')
  const [activeTab, setActiveTab] = useState('summary')
  const [page, setPage] = useState(0)
  const [sorting, setSorting] = useState<{ columnId: string; desc: boolean } | null>(null)
  const [colFilters, setColFilters] = useState<GlobalTableFilters>({})
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({ sourceConceptId: false })

  // Export tab state
  const [exportStatuses, setExportStatuses] = useState<Set<MappingStatus>>(new Set(['approved']))
  const [exportApprovalRule, setExportApprovalRule] = useState<'at_least_one' | 'majority' | 'no_rejections'>('at_least_one')
  const [exportGroupFilter, setExportGroupFilter] = useState<Set<string>>(new Set())
  const [exportIncludeUnmapped, setExportIncludeUnmapped] = useState(false)

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

  // Load registry entries for this workspace (used in table + export)
  const loadRegistry = useCallback(async () => {
    if (!activeWorkspaceId) return
    const ranges = await getStorage().sourceConceptIdRanges.getByWorkspace(activeWorkspaceId)
    if (ranges.length === 0) { setRegistryEntries([]); return }
    const all = await Promise.all(
      ranges.map((r) => getStorage().sourceConceptIdEntries.getByWorkspaceAndBadge(activeWorkspaceId, r.badgeLabel)),
    )
    setRegistryEntries(all.flat())
  }, [activeWorkspaceId])

  useEffect(() => { loadAllMappings() }, [loadAllMappings])
  useEffect(() => { loadRegistry() }, [loadRegistry])

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
    return key
  }, [])

  const totals = useMemo(() => {
    // Count unique source concepts globally (across all groups, deduplicated)
    const allSourceKeys = new Set<string>()
    let approved = 0, flagged = 0, rejected = 0, unchecked = 0, ignored = 0
    for (const g of groupStats.values()) {
      for (const k of g.uniqueSourceConceptKeys) allSourceKeys.add(k)
      approved += g.approved
      flagged += g.flagged
      rejected += g.rejected
      unchecked += g.unchecked
      ignored += g.ignored
    }
    // Total source concepts: file projects → rows.length; DB projects → not available without query
    let totalSourceConcepts = 0
    for (const p of projects) {
      if (p.sourceType === 'file') {
        totalSourceConcepts += p.fileSourceData?.rows.length ?? 0
      }
      // DB projects: stats.totalSourceConcepts is always 0 (needs live DuckDB query)
      // We'll fall back to 0, meaning no % will be shown for DB-only workspaces
    }
    const uniqueMapped = allSourceKeys.size
    const unmapped = totalSourceConcepts > 0 ? Math.max(0, totalSourceConcepts - uniqueMapped) : 0
    return { total: totalSourceConcepts || uniqueMapped, totalSourceConcepts, uniqueMapped, approved, flagged, rejected, unchecked, ignored, unmapped }
  }, [groupStats, projects])

  const chartData = useMemo(() => groupNames.map((name) => {
    const g = groupStats.get(name)!
    const displayName = getDisplayName(name)
    const unmapped = g.totalSourceConceptsFromStats > 0
      ? Math.max(0, g.totalSourceConceptsFromStats - g.uniqueSourceConcepts)
      : 0
    return {
      name: displayName.length > 20 ? displayName.slice(0, 18) + '…' : displayName,
      approved: g.approved, flagged: g.flagged, rejected: g.rejected,
      unchecked: g.unchecked, ignored: g.ignored, unmapped,
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

  // Registry lookup: (vocabularyId, conceptCode) → sourceConceptId
  const registryMap = useMemo(
    () => new Map(registryEntries.map((e) => [`${e.vocabularyId}__${e.conceptCode}`, e.sourceConceptId])),
    [registryEntries],
  )

  // project mode: one row per mapping, with registry-resolved sourceConceptId
  // resolvedSourceConceptId is undefined when there's no registry entry (artificial ID, not yet assigned)
  const flatRows = useMemo<GlobalMappingRow[]>(() => {
    if (groupMode === 'badge') return []
    return allMappings.map((m) => {
      const proj = tableProjectMap.get(m.projectId)
      const isArtificialId = proj?.sourceType === 'database'
        || (proj?.sourceType === 'file' && !proj.fileSourceData?.columnMapping?.conceptIdColumn)
      const resolvedSourceConceptId = isArtificialId
        ? registryMap.get(`${m.sourceVocabularyId}__${m.sourceConceptCode}`)
        : m.sourceConceptId
      return {
        ...m,
        resolvedSourceConceptId,
        projectName: tableProjectMap.get(m.projectId)?.name ?? m.projectId,
      }
    })
  }, [allMappings, tableProjectMap, groupMode, registryMap])

  const allEquivs = useMemo(() => {
    const vals = groupMode === 'badge'
      ? deduplicatedRows.map((r) => r.equivalence)
      : flatRows.map((r) => r.equivalence)
    return [...new Set(vals.filter(Boolean) as string[])].sort()
  }, [groupMode, deduplicatedRows, flatRows])

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
      if (f.groupLabels?.size && !f.groupLabels.has(r.projectName)) return false
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

  // Export: mappings filtered by group only (used for per-status counts in the checkbox UI)
  const exportGroupOnlyMappings = useMemo(() => {
    const hasGroupFilter = exportGroupFilter.size > 0
    let result = hasGroupFilter
      ? allMappings.filter((m) => {
          const p = projects.find((proj) => proj.id === m.projectId)
          if (groupMode === 'badge') {
            const labels = (p?.badges ?? []).map((b) => b.label)
            return labels.some((l) => exportGroupFilter.has(l))
          }
          const name = p?.name ?? m.projectId
          return exportGroupFilter.has(name)
        })
      : allMappings

    // Badge mode: deduplicate by (sourceConceptCode || sourceConceptId, targetConceptId)
    if (groupMode === 'badge') {
      const seen = new Set<string>()
      result = result.filter((m) => {
        const key = `${m.sourceConceptCode ?? m.sourceConceptId}__${m.targetConceptId}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }

    return result
  }, [allMappings, projects, exportGroupFilter, groupMode])

  // Export filtered mappings
  const exportFilteredMappings = useMemo(() => {
    // Group filter: project names or badge labels
    const hasGroupFilter = exportGroupFilter.size > 0
    let result = allMappings.filter((m) => {
      if (hasGroupFilter) {
        const p = projects.find((proj) => proj.id === m.projectId)
        if (groupMode === 'badge') {
          const labels = (p?.badges ?? []).map((b) => b.label)
          if (!labels.some((l) => exportGroupFilter.has(l))) return false
        } else {
          // project mode
          const name = p?.name ?? m.projectId
          if (!exportGroupFilter.has(name)) return false
        }
      }
      return exportStatuses.has(effectiveStatus(m))
    })

    // Approval sub-rule
    if (exportStatuses.has('approved') && exportApprovalRule !== 'at_least_one') {
      const sourceConceptStatuses = new Map<string, MappingStatus[]>()
      for (const m of allMappings) {
        const key = `${m.projectId}:${m.sourceConceptId}`
        const arr = sourceConceptStatuses.get(key) ?? []
        arr.push(effectiveStatus(m))
        sourceConceptStatuses.set(key, arr)
      }
      result = result.filter((m) => {
        if (effectiveStatus(m) !== 'approved') return true
        const key = `${m.projectId}:${m.sourceConceptId}`
        const statuses = sourceConceptStatuses.get(key) ?? []
        const approvedCount = statuses.filter((s) => s === 'approved').length
        const rejectedCount = statuses.filter((s) => s === 'rejected').length
        if (exportApprovalRule === 'majority') return approvedCount > rejectedCount
        if (exportApprovalRule === 'no_rejections') return rejectedCount === 0
        return true
      })
    }
    // Badge mode: deduplicate by (sourceConceptCode || sourceConceptId, targetConceptId) — same as the datatable
    if (groupMode === 'badge') {
      const seen = new Set<string>()
      result = result.filter((m) => {
        const key = `${m.sourceConceptCode ?? m.sourceConceptId}__${m.targetConceptId}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }

    return result
  }, [allMappings, projects, exportStatuses, exportApprovalRule, exportGroupFilter, groupMode])

  const exportGroupOptions = useMemo(() => {
    if (groupMode === 'badge') {
      const labels = new Set<string>()
      for (const p of projects) for (const b of p.badges ?? []) if (b.label) labels.add(b.label)
      return Array.from(labels).sort()
    }
    return projects.map((p) => p.name).sort()
  }, [projects, groupMode])

  const handleExportDownload = async (format: 'sssom' | 'stcm' | 'usagi') => {
    if (format === 'sssom') {
      const virtualProject = { name: 'global', id: 'global' } as MappingProject
      downloadFile(exportToSssomTsv(exportFilteredMappings, virtualProject), `global-sssom.tsv`, 'text/tab-separated-values')
    } else if (format === 'stcm') {
      const entries = registryEntries.length > 0 ? registryEntries : undefined
      const mappedCsv = exportToSourceToConceptMap(exportFilteredMappings, projects, entries)

      if (!exportIncludeUnmapped) {
        downloadFile(mappedCsv, `global-source-to-concept-map.csv`, 'text/csv')
        return
      }

      // Collect ALL source concepts across all filtered projects
      const filteredProjectIds = exportGroupFilter.size > 0
        ? new Set(projects.filter((p) => {
            const labels = (p.badges ?? []).map((b) => b.label)
            return groupMode === 'badge'
              ? labels.some((l) => exportGroupFilter.has(l))
              : exportGroupFilter.has(p.name)
          }).map((p) => p.id))
        : null

      const filteredProjects = filteredProjectIds
        ? projects.filter((p) => filteredProjectIds.has(p.id))
        : projects

      const allSourceConcepts: { vocabularyId: string; conceptCode: string; conceptName: string }[] = []
      for (const proj of filteredProjects) {
        if (proj.sourceType === 'file') {
          if (proj.fileSourceData?.columnMapping?.conceptIdColumn) continue
          const rows = proj.fileSourceData?.rows ?? []
          const colMapping = proj.fileSourceData?.columnMapping
          const codeCol = colMapping?.conceptCodeColumn
          const vocabCol = colMapping?.terminologyColumn
          const nameCol = colMapping?.conceptNameColumn
          for (const row of rows) {
            const code = codeCol ? String(row[codeCol] ?? '') : ''
            const vocab = vocabCol ? String(row[vocabCol] ?? '') : proj.name
            const name = nameCol ? String(row[nameCol] ?? '') : code
            if (code) allSourceConcepts.push({ vocabularyId: vocab, conceptCode: code, conceptName: name })
          }
        } else {
          const ds = dataSources.find((s) => s.id === proj.dataSourceId)
          if (!ds?.schemaMapping) continue
          try {
            await ensureMounted(ds.id)
            const sql = buildSourceConceptsAllQuery(ds.schemaMapping, {})
            if (!sql) continue
            const rows = await queryDataSource(ds.id, sql)
            for (const r of rows) {
              const code = String(r.concept_code ?? '')
              const vocab = String(r.vocabulary_id ?? ds.id)
              const name = String(r.concept_name ?? '')
              if (code) allSourceConcepts.push({ vocabularyId: vocab, conceptCode: code, conceptName: name })
            }
          } catch { /* skip if unavailable */ }
        }
      }

      const mappedKeys = new Set(exportFilteredMappings.map((m) => `${m.sourceVocabularyId}__${m.sourceConceptCode}`))
      const unmappedCsv = exportUnmappedToStcm(allSourceConcepts, mappedKeys, entries)

      let finalCsv = mappedCsv
      if (unmappedCsv) {
        const unmappedRows = unmappedCsv.split('\n').slice(1).join('\n')
        if (unmappedRows) finalCsv = mappedCsv ? `${mappedCsv}\n${unmappedRows}` : unmappedCsv
      }
      downloadFile(finalCsv, `global-source-to-concept-map.csv`, 'text/csv')
    } else {
      downloadFile(exportToUsagiCsv(exportFilteredMappings), `global-usagi.csv`, 'text/csv')
    }
  }

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
      header: () => t('concept_mapping.global_project_col'),
      accessorFn: (r) => r.projectName,
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
      id: 'sourceConceptId',
      header: () => t('concept_mapping.col_source_concept_id'),
      accessorFn: (r) => r.resolvedSourceConceptId,
      cell: ({ row }) => row.original.resolvedSourceConceptId != null
        ? <span className="font-mono text-xs text-muted-foreground">{row.original.resolvedSourceConceptId}</span>
        : <span className="text-xs text-muted-foreground/30">—</span>,
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
    : t('concept_mapping.global_badge')

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
            onValueChange={(v: 'project' | 'badge') => {
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
            </SelectContent>
          </Select>
        </div>
        <Badge variant="secondary" className="text-[10px] ml-auto">
          {projects.length} {t('concept_mapping.global_projects')} · {totals.total.toLocaleString()} {t('concept_mapping.prog_total_source_concepts')}
        </Badge>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 flex-col overflow-hidden">
        <div className="flex justify-center border-b">
          <TabsList className="my-2 w-fit">
            <TabsTrigger value="summary">{t('concept_mapping.global_tab_summary')}</TabsTrigger>
            <TabsTrigger value="table">{t('concept_mapping.global_tab_table')}</TabsTrigger>
            <TabsTrigger value="source-ids">{t('concept_mapping.global_tab_source_ids')}</TabsTrigger>
            <TabsTrigger value="export">{t('concept_mapping.tab_export')}</TabsTrigger>
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
              {/* Global big numbers — same style as ProgressTab */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Card className="p-4 text-center">
                  <p className="text-2xl font-bold">{totals.total.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_total_source_concepts')}</p>
                </Card>
                <Card className="p-4 text-center">
                  <p className="text-2xl font-bold text-blue-600">
                    {totals.uniqueMapped.toLocaleString()}
                    {totals.totalSourceConcepts > 0 && (
                      <span className="ml-1 text-sm font-normal text-muted-foreground">
                        ({Math.round((totals.uniqueMapped / totals.totalSourceConcepts) * 100)}%)
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_source_concepts')}</p>
                </Card>
                <Card className="p-4 text-center">
                  <p className="text-2xl font-bold text-green-600">
                    {totals.approved.toLocaleString()}
                    {totals.totalSourceConcepts > 0 && (
                      <span className="ml-1 text-sm font-normal text-muted-foreground">
                        ({Math.round((totals.approved / totals.totalSourceConcepts) * 100)}%)
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_approved')}</p>
                </Card>
                <Card className="p-4 text-center">
                  <p className="text-2xl font-bold text-orange-500">{totals.flagged.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_flagged')}</p>
                </Card>
                <Card className="p-4 text-center">
                  <p className="text-2xl font-bold text-gray-500">{totals.ignored.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">{t('concept_mapping.prog_ignored')}</p>
                </Card>
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
                      {(['approved', 'unchecked', 'flagged', 'rejected', 'ignored', 'unmapped'] as const).map((s) => (
                        <Bar
                          key={s}
                          dataKey={s}
                          stackId="a"
                          fill={STATUS_BAR_COLORS[s]}
                          name={s === 'unmapped' ? t('concept_mapping.filter_unmapped') : t(`concept_mapping.status_${s}`)}
                          radius={s === 'unmapped' ? [0, 4, 4, 0] : undefined}
                        />
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
                      <TableHead className="text-right text-xs capitalize">{t('concept_mapping.prog_source_concepts')}</TableHead>
                      <TableHead className="text-right text-xs">{t('concept_mapping.prog_approved')}</TableHead>
                      <TableHead className="text-right text-xs">{t('concept_mapping.prog_flagged')}</TableHead>
                      <TableHead className="text-right text-xs">{t('concept_mapping.status_rejected')}</TableHead>
                      <TableHead className="text-right text-xs">%</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groupNames.map((name) => {
                      const g = groupStats.get(name)!
                      const denominator = g.totalSourceConceptsFromStats > 0 ? g.totalSourceConceptsFromStats : g.uniqueSourceConcepts
                      const pct = denominator > 0 ? Math.round((g.approved / denominator) * 100) : 0
                      return (
                        <TableRow key={name} className="text-xs">
                          <TableCell className="font-medium">{getDisplayName(name)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{g.projectCount}</TableCell>
                          <TableCell className="text-right">{g.uniqueSourceConcepts.toLocaleString()}</TableCell>
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

        {/* ── EXPORT TAB ── */}
        <TabsContent value="export" className="flex-1 overflow-auto p-4">
          <div className="mx-auto max-w-3xl space-y-6">

            {/* Group filter */}
            {exportGroupOptions.length > 0 && (
              <Card className="p-4">
                <p className="mb-3 text-sm font-medium">
                  {t('concept_mapping.global_group_by')}: <span className="font-normal text-muted-foreground">{groupModeLabel}</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  {exportGroupOptions.map((opt) => {
                    const active = exportGroupFilter.has(opt)
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setExportGroupFilter((prev) => {
                          const next = new Set(prev)
                          if (next.has(opt)) next.delete(opt)
                          else next.add(opt)
                          return next
                        })}
                        className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground'}`}
                      >
                        {opt}
                      </button>
                    )
                  })}
                  {exportGroupFilter.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setExportGroupFilter(new Set())}
                      className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {t('common.clear')}
                    </button>
                  )}
                </div>
              </Card>
            )}

            {/* Status filter */}
            <Card className="p-4">
              <p className="mb-3 text-sm font-medium">{t('concept_mapping.export_filter_title')}</p>
              <div className="space-y-2">
                {(['approved', 'rejected', 'flagged', 'unchecked', 'ignored'] as MappingStatus[]).map((status) => {
                  const checked = exportStatuses.has(status)
                  return (
                    <div key={status}>
                      <label className="flex cursor-pointer items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setExportStatuses((prev) => {
                            const next = new Set(prev)
                            if (next.has(status)) next.delete(status)
                            else next.add(status)
                            return next
                          })}
                          className="size-3.5 rounded border-gray-300 accent-primary"
                        />
                        <span className="text-xs">{t(`concept_mapping.status_${status}`)}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {exportGroupOnlyMappings.filter((m) => effectiveStatus(m) === status).length}
                        </Badge>
                      </label>
                      {status === 'approved' && checked && (
                        <div className="ml-6 mt-1.5 space-y-1">
                          {(['at_least_one', 'majority', 'no_rejections'] as const).map((rule) => (
                            <label key={rule} className="flex cursor-pointer items-center gap-2">
                              <input
                                type="radio"
                                name="export-approval-rule"
                                checked={exportApprovalRule === rule}
                                onChange={() => setExportApprovalRule(rule)}
                                className="size-3 accent-primary"
                              />
                              <span className="text-[11px] text-muted-foreground">{t(`concept_mapping.export_rule_${rule}`)}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {/* Unmapped (STCM only) */}
                <div>
                  <label className="flex cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={exportIncludeUnmapped}
                      onChange={() => setExportIncludeUnmapped((v) => !v)}
                      className="size-3.5 rounded border-gray-300 accent-primary"
                    />
                    <span className="text-xs">{t('concept_mapping.export_unmapped')}</span>
                    {totals.unmapped > 0 && (
                      <Badge variant="secondary" className="text-[10px]">{totals.unmapped}</Badge>
                    )}
                    <span className="text-[10px] text-muted-foreground">{t('concept_mapping.export_unmapped_stcm_only')}</span>
                  </label>
                </div>
              </div>

              <div className="mt-3 border-t pt-3">
                <p className="text-xs text-muted-foreground">
                  {t('concept_mapping.export_total')}: <strong>{exportFilteredMappings.length}</strong> {t('concept_mapping.export_mappings_count')}
                </p>
              </div>
            </Card>

            {/* Format cards */}
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                {
                  id: 'sssom' as const,
                  icon: FileCode,
                  name: t('concept_mapping.export_sssom'),
                  description: t('concept_mapping.export_sssom_desc'),
                  ext: 'tsv',
                  color: 'text-violet-500',
                  bg: 'bg-violet-50 dark:bg-violet-950/30',
                },
                {
                  id: 'stcm' as const,
                  icon: FileText,
                  name: t('concept_mapping.export_stcm'),
                  description: t('concept_mapping.export_stcm_desc'),
                  ext: 'csv',
                  color: 'text-blue-500',
                  bg: 'bg-blue-50 dark:bg-blue-950/30',
                },
                {
                  id: 'usagi' as const,
                  icon: FileSpreadsheet,
                  name: t('concept_mapping.export_usagi'),
                  description: t('concept_mapping.export_usagi_desc'),
                  ext: 'csv',
                  color: 'text-emerald-500',
                  bg: 'bg-emerald-50 dark:bg-emerald-950/30',
                },
              ].map((fmt) => (
                <Card key={fmt.id} className="flex flex-col justify-between overflow-hidden p-0">
                  <div className={`flex items-center gap-2.5 px-4 py-3 ${fmt.bg}`}>
                    <fmt.icon size={16} className={`shrink-0 ${fmt.color}`} />
                    <span className="text-sm font-medium">{fmt.name}</span>
                    <Badge variant="outline" className="ml-auto text-[10px]">.{fmt.ext}</Badge>
                  </div>
                  <div className="px-4 py-3">
                    <p className="text-xs text-muted-foreground">{fmt.description}</p>
                  </div>
                  <div className="px-4 pb-4">
                    <Button
                      className="w-full"
                      variant="outline"
                      size="sm"
                      onClick={() => handleExportDownload(fmt.id)}
                      disabled={exportFilteredMappings.length === 0}
                    >
                      <Download size={14} />
                      {t('concept_mapping.export_download')}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </TabsContent>

        {/* ── SOURCE IDs TAB ── */}
        <TabsContent value="source-ids" className="flex-1 overflow-hidden">
          {activeWorkspaceId && (
            <SourceIdTab
              workspaceId={activeWorkspaceId}
              projects={projects}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
