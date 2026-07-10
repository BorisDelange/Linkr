import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, LayoutGrid, Settings2, ArrowUpDown, ArrowUp, ArrowDown, Download, FileCode, FileText, FileSpreadsheet, Search, SlidersHorizontal, X } from 'lucide-react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
  type Table as TanstackTable,
} from '@tanstack/react-table'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Tooltip as UiTooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { MultiSelectFilter as SharedMultiSelectFilter } from '@/components/ui/multi-select-filter'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getStorage } from '@/lib/storage'
import {
  exportToUsagiCsv,
  exportToSourceToConceptMap,
  exportToSssomTsv,
  exportUnmappedToStcm,
  downloadFile,
} from '@/lib/concept-mapping/export'
import { buildSourceConceptsAllQuery, buildSourceConceptsCountQuery } from '@/lib/concept-mapping/mapping-queries'
import { effectiveMappingStatus } from '@/lib/concept-mapping/mapping-status'
import { localized } from '@/lib/localized'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { queryDataSource, queryDataSourceAll, mountFileSourceIntoDuckDB, fileSourceDataSourceId } from '@/lib/duckdb/engine'
import {
  populateFlatTable,
  populateDedupTable,
  invalidateGlobalTables,
  queryFlatCount,
  queryFlatPage,
  queryDedupCount,
  queryDedupPage,
  queryFlatDistinct,
  queryDedupDistinct,
} from '@/lib/concept-mapping/global-summary-queries'
import { SourceIdTab } from './SourceIdTab'
import type { ConceptMapping, MappingProject, MappingStatus, SourceConceptIdEntry } from '@/types'

interface GlobalSummaryViewProps {
  onBack: () => void
}

const STATUS_BAR_COLORS: Record<string, string> = {
  approved: '#34d399',
  flagged: '#fb923c',
  rejected: '#ef4444',
  ignored: '#a78bfa',  // violet — voluntarily ignored
  unchecked: '#94a3b8', // slate — not yet reviewed
  unmapped: '#e2e8f0',  // very light — not yet touched
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
const EXPORT_STATUSES: MappingStatus[] = ['approved', 'rejected', 'flagged', 'unchecked', 'ignored']
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

/** Resolve the displayable status of a mapping, reusing the store helper so the
 *  Global Summary stays consistent with what's shown in MappingsTab cells.
 *  effectiveMappingStatus may return 'disputed' when reviews disagree — for the
 *  purpose of summing into per-status buckets, we count 'disputed' separately
 *  (it falls into `unchecked` by current grouping; could grow its own bucket later). */
function effectiveStatus(m: ConceptMapping): MappingStatus {
  const eff = effectiveMappingStatus(m)
  // 'disputed' is a display-only state; it's not one of the five buckets the
  // summary aggregates into. Treat it as 'unchecked' until the UI grows a
  // dedicated bucket.
  return eff === 'disputed' ? 'unchecked' : eff
}

function computeGroupStats(
  mappings: ConceptMapping[],
  projects: MappingProject[],
  groupMode: 'project' | 'badge',
  dbProjectTotals: Map<string, number>,
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

  // Group keys a project belongs to (its name in project mode, its badge labels
  // in badge mode — 'Other' when it has none).
  const projectKeys = (p: MappingProject): string[] => {
    if (groupMode === 'project') return [localized(p.name, 'en')]
    const labels = (p.badges ?? []).map((b) => b.label).filter(Boolean)
    return labels.length > 0 ? labels : ['Other']
  }

  // Compute per-project total from stats for the group aggregation
  // We count each project's stats once per group key it belongs to
  const projectStatsCounted = new Set<string>() // `${groupKey}__${projectId}`

  // Seed groups + their source-concept totals from the PROJECTS themselves, so a
  // project with source concepts but no mappings yet still appears in the table
  // (mappings-only iteration would drop it entirely — empty Summary table).
  for (const p of projects) {
    const projectTotal = p.sourceType === 'file'
      ? (p.fileSourceData?.totalRowCount ?? p.fileSourceData?.rows.length ?? 0)
      : (dbProjectTotals.get(p.id) ?? 0)
    for (const key of projectKeys(p)) {
      const g = ensure(key)
      g.projectIds.add(p.id)
      const statKey = `${key}__${p.id}`
      if (!projectStatsCounted.has(statKey)) {
        projectStatsCounted.add(statKey)
        g.totalSourceConceptsFromStats += projectTotal
      }
    }
  }

  for (const m of mappings) {
    const p = projectMap.get(m.projectId)
    // Totals were already seeded per project above; here we only fold in the
    // mapping-derived stats (status counts, mapped source concepts).
    const keys = p ? projectKeys(p) : []
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

/// Raw source concept row loaded from DuckDB or file
interface SourceConceptRaw {
  concept_id: number
  concept_name: string
  concept_code: string
  vocabulary_id: string
}

// Row for project/status mode: one row per mapping (or unmapped source concept)
interface GlobalMappingRow extends ConceptMapping {
  projectName: string
  resolvedSourceConceptId: number | undefined
  isUnmapped?: boolean
}

// Row for badge mode: deduplicated by (sourceConceptCode, targetConceptId), votes aggregated
interface DeduplicatedMappingRow {
  key: string
  isUnmapped?: boolean
  resolvedSourceConceptId?: number
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
  statusFilter?: Set<string>  // multi-select: statuses + 'unmapped'
  groupLabels?: Set<string>  // multi-select: badge labels, project names, or statuses
  sourceVocabularyId?: string | null
  sourceConceptId?: string
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
  const [dbProjectTotals, setDbProjectTotals] = useState<Map<string, number>>(new Map())
  // All source concepts per project: projectId → SourceConceptRaw[]
  const [allSourceConceptsByProject, setAllSourceConceptsByProject] = useState<Map<string, SourceConceptRaw[]>>(new Map())
  const [registryEntries, setRegistryEntries] = useState<SourceConceptIdEntry[]>([])
  const [groupMode, setGroupMode] = useState<'project' | 'badge'>('project')
  const [activeTab, setActiveTab] = useState('summary')
  const [sorting, setSorting] = useState<{ columnId: string; desc: boolean } | null>(null)
  const [colFilters, setColFilters] = useState<GlobalTableFilters>({})
  // Search bar: typed text is local, commits to colFilters.globalSearch on Enter / button.
  const [pendingSearch, setPendingSearch] = useState('')
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({ sourceConceptCode: false, targetConceptId: false })
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({})

  // ── Table tab: DuckDB-backed pagination ──
  const [tableRows, setTableRows] = useState<Record<string, unknown>[]>([])
  const [tableTotalCount, setTableTotalCount] = useState(0)
  const [tableLoading, setTableLoading] = useState(false)
  const [tableHasMore, setTableHasMore] = useState(false)
  const [tableReady, setTableReady] = useState(false)
  // True while populateTable is inserting rows into the DuckDB temp table. Can take
  // tens of seconds to minutes for large workspaces (~300k+ rows). The body shows
  // a loading row in this state instead of "Aucun résultat".
  const [tablePopulating, setTablePopulating] = useState(false)
  // True while loadSourceConcepts pulls every project's source concepts from the
  // server (paged; can take a while on 100k+ rows). Without this the table shows
  // "No results" during that load instead of a spinner.
  const [loadingSourceConcepts, setLoadingSourceConcepts] = useState(false)
  const tablePage = useRef(0)
  const tableLoadingRef = useRef(false)

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

    // Mappings for every project, fetched in parallel (one round-trip each in
    // server mode — running them serially was the dominant open-view lag).
    const perProject = await Promise.all(
      projects.map((p) => getStorage().conceptMappings.getByProject(p.id)),
    )
    setAllMappings(perProject.flat())

    // Summary needs only per-project source-concept COUNTS (cheap aggregate),
    // not every source row. The heavy all-rows fetch is deferred to the Table/
    // Export tabs (loadSourceConcepts). Counts run in parallel too.
    const dbProjects = projects.filter(
      (p) => p.sourceType !== 'file' && !p.fileSourceData,
    )
    const counts = await Promise.all(
      dbProjects.map(async (p) => {
        const ds = dataSources.find((d) => d.id === p.dataSourceId)
        if (!ds?.schemaMapping) return [p.id, 0] as const
        try {
          await ensureMounted(ds.id)
          const countSql = buildSourceConceptsCountQuery(ds.schemaMapping, {})
          if (!countSql) return [p.id, 0] as const
          const [row] = await queryDataSource(ds.id, countSql)
          return [p.id, Number(row?.total ?? 0)] as const
        } catch {
          return [p.id, 0] as const
        }
      }),
    )
    setDbProjectTotals(new Map(counts))

    setLoadingMappings(false)
  }, [projects, dataSources, ensureMounted])

  // Heavy: all source-concept ROWS for every project (used only by the Table /
  // Export tabs). Deferred until one of those tabs is opened; runs in parallel.
  const loadSourceConcepts = useCallback(async () => {
    setLoadingSourceConcepts(true)
    const sourceConceptsMap = new Map<string, SourceConceptRaw[]>()
    try {
    await Promise.all(
      projects.map(async (p) => {
        const isFile = p.sourceType === 'file' || !!p.fileSourceData
        if (isFile) {
          if (!p.fileSourceData) return
          try {
            await mountFileSourceIntoDuckDB(p.id, p.fileSourceData.rows, p.fileSourceData.columnMapping, p.fileSourceData.rawFileBuffer)
            const dsId = fileSourceDataSourceId(p.id)
            // SELECT * (not a hard-coded column list): the source_concepts view only
            // exposes vocabulary_id when a terminology column was mapped, so naming
            // it explicitly threw a Binder error that was silently swallowed here —
            // leaving the table empty. Read whatever columns exist, with fallbacks.
            // queryDataSourceAll, not queryDataSource: the server caps a single
            // response at MAX_QUERY_ROWS (10k), which capped the whole table at
            // "10k total". Page through to load every source concept.
            const rows = await queryDataSourceAll(dsId, 'SELECT * FROM source_concepts')
            const seen = new Map<string, SourceConceptRaw>()
            for (const row of rows) {
              const code = String(row.concept_code ?? '')
              const name = String(row.concept_name ?? '')
              const vocab = String(row.vocabulary_id ?? localized(p.name, 'en'))
              const id = Number(row.concept_id ?? 0)
              const key = `${vocab}__${code}`
              if (!seen.has(key)) seen.set(key, { concept_id: id, concept_name: name, concept_code: code, vocabulary_id: vocab })
            }
            sourceConceptsMap.set(p.id, Array.from(seen.values()))
          } catch { /* skip on mount/query failure */ }
          return
        }
        const ds = dataSources.find((d) => d.id === p.dataSourceId)
        if (!ds?.schemaMapping) return
        try {
          await ensureMounted(ds.id)
          const allSql = buildSourceConceptsAllQuery(ds.schemaMapping, {})
          if (!allSql) return
          const rows = await queryDataSourceAll(ds.id, allSql)
          sourceConceptsMap.set(p.id, rows.map((row) => ({
            concept_id: Number(row.concept_id ?? 0),
            concept_name: String(row.concept_name ?? ''),
            concept_code: String(row.concept_code || row.concept_id || ''),
            vocabulary_id: String(row.vocabulary_id ?? ds.id),
          })))
        } catch { /* skip if DuckDB unavailable */ }
      }),
    )
    setAllSourceConceptsByProject(sourceConceptsMap)
    } finally {
      setLoadingSourceConcepts(false)
    }
  }, [projects, dataSources, ensureMounted])

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

  // ── Table tab: DuckDB pagination functions ──
  const registryMap = useMemo(
    () => new Map(registryEntries.map((e) => [`${e.vocabularyId}__${e.conceptCode}`, e.sourceConceptId])),
    [registryEntries],
  )

  // Populate DuckDB temp table when data is ready
  const populateTable = useCallback(async () => {
    if (loadingMappings) return
    invalidateGlobalTables()
    setTablePopulating(true)
    try {
      if (groupMode === 'badge') {
        await populateDedupTable(allMappings, allSourceConceptsByProject, projects, registryMap)
      } else {
        await populateFlatTable(allMappings, allSourceConceptsByProject, projects, registryMap)
      }
      setTableReady(true)
    } catch (err) {
      console.error('Failed to populate global summary table:', err)
    } finally {
      setTablePopulating(false)
    }
  }, [loadingMappings, allMappings, allSourceConceptsByProject, projects, registryMap, groupMode])

  // Load a page of rows from DuckDB
  const loadTableRows = useCallback(async (pageToLoad: number) => {
    if (!tableReady || tableLoadingRef.current) return
    tableLoadingRef.current = true
    setTableLoading(true)
    try {
      const queryCount = groupMode === 'badge' ? queryDedupCount : queryFlatCount
      const queryPage = groupMode === 'badge' ? queryDedupPage : queryFlatPage

      if (pageToLoad === 0) {
        const count = await queryCount(colFilters)
        setTableTotalCount(count)
      }

      const rows = await queryPage(colFilters, sorting, PAGE_SIZE, pageToLoad * PAGE_SIZE)

      if (pageToLoad === 0) {
        setTableRows(rows)
      } else {
        setTableRows((prev) => [...prev, ...rows])
      }
      setTableHasMore(rows.length === PAGE_SIZE)
    } catch (err) {
      console.error('Failed to load table rows:', err)
      if (pageToLoad === 0) setTableRows([])
    } finally {
      setTableLoading(false)
      tableLoadingRef.current = false
    }
  }, [tableReady, groupMode, colFilters, sorting])

  const loadTableRowsRef = useRef(loadTableRows)
  loadTableRowsRef.current = loadTableRows

  useEffect(() => { loadAllMappings() }, [loadAllMappings])
  useEffect(() => { loadRegistry() }, [loadRegistry])
  // Re-load registry when switching to table or export tab (entries may have been assigned meanwhile)
  useEffect(() => {
    if (activeTab === 'table' || activeTab === 'export') loadRegistry()
  }, [activeTab, loadRegistry])

  // Load the heavy source-concept rows lazily, only when the Table/Export tab is
  // first opened (the Summary tab needs only the counts loaded above). Reloads
  // if the project set changes.
  const sourceConceptsLoadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (activeTab !== 'table' && activeTab !== 'export') return
    const key = projects.map((p) => p.id).join(',')
    if (sourceConceptsLoadedRef.current === key) return
    sourceConceptsLoadedRef.current = key
    void loadSourceConcepts()
  }, [activeTab, projects, loadSourceConcepts])

  // Populate DuckDB table the first time the user opens the Table tab, or when
  // the underlying data / grouping changes. We do NOT re-populate on every tab
  // switch — once the temp table exists, it stays valid until allMappings or
  // groupMode change. Switching from Summary → Table → Summary → Table is a no-op.
  const lastPopulateKey = useRef<string | null>(null)
  useEffect(() => {
    if (activeTab !== 'table' || loadingMappings) return
    // Key on the inputs that actually require a rebuild of the temp table.
    // allSourceConceptsByProject is loaded ASYNCHRONOUSLY (loadSourceConcepts,
    // server round-trip) and lands AFTER allMappings, so it MUST be in the key —
    // otherwise a freshly imported project with no mappings yet populates the
    // table before its source concepts arrive, and never rebuilds → empty table.
    const srcCount = [...allSourceConceptsByProject.values()].reduce((n, a) => n + a.length, 0)
    const key = `${groupMode}::${allMappings.length}::${allMappings.length > 0 ? allMappings[allMappings.length - 1].updatedAt : ''}::${allSourceConceptsByProject.size}:${srcCount}`
    if (lastPopulateKey.current === key && tableReady) return
    lastPopulateKey.current = key
    invalidateGlobalTables()
    setTableReady(false)
    setTableRows([])
    populateTable()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, loadingMappings, groupMode, allMappings, allSourceConceptsByProject])

  // Load first page when table is ready or filters/sorting change
  useEffect(() => {
    if (!tableReady) return
    tablePage.current = 0
    setTableRows([])
    setTableHasMore(false)
    loadTableRowsRef.current(0)
  }, [tableReady, colFilters, sorting])

  // Load next page on scroll
  const handleLoadMore = useCallback(() => {
    if (tableLoading || !tableHasMore) return
    tablePage.current += 1
    loadTableRowsRef.current(tablePage.current)
  }, [tableLoading, tableHasMore])

  const groupStats = useMemo(
    () => computeGroupStats(allMappings, projects, groupMode, dbProjectTotals),
    [allMappings, projects, groupMode, dbProjectTotals],
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
    // Total source concepts: file → rows.length; DB → DuckDB count query result
    let totalSourceConcepts = 0
    for (const p of projects) {
      if (p.sourceType === 'file') {
        totalSourceConcepts += p.fileSourceData?.totalRowCount ?? p.fileSourceData?.rows.length ?? 0
      } else {
        totalSourceConcepts += dbProjectTotals.get(p.id) ?? 0
      }
    }
    const uniqueMapped = allSourceKeys.size
    const unmapped = totalSourceConcepts > 0 ? Math.max(0, totalSourceConcepts - uniqueMapped) : 0
    return { total: totalSourceConcepts || uniqueMapped, totalSourceConcepts, uniqueMapped, approved, flagged, rejected, unchecked, ignored, unmapped }
  }, [groupStats, projects, dbProjectTotals])

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

  // ── Table tab: filter dropdown options (loaded from DuckDB DISTINCT) ──
  const [allEquivs, setAllEquivs] = useState<string[]>([])
  const [allSourceVocabs, setAllSourceVocabs] = useState<string[]>([])
  const [allTargetVocabs, setAllTargetVocabs] = useState<string[]>([])

  const allBadgeLabels = useMemo(() => {
    const labels = new Set<string>()
    for (const p of projects) for (const b of p.badges ?? []) if (b.label) labels.add(b.label)
    return Array.from(labels).sort()
  }, [projects])

  // Load filter options from DuckDB when table is ready
  useEffect(() => {
    if (!tableReady) return
    const queryDistinct = groupMode === 'badge' ? queryDedupDistinct : queryFlatDistinct
    queryDistinct('equivalence').then(setAllEquivs).catch(() => {})
    queryDistinct('source_vocabulary_id').then(setAllSourceVocabs).catch(() => {})
    queryDistinct('target_vocabulary_id').then(setAllTargetVocabs).catch(() => {})
  }, [tableReady, groupMode])

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
          const name = p ? localized(p.name, 'en') : m.projectId
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
          const name = p ? localized(p.name, 'en') : m.projectId
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
    return projects.map((p) => localized(p.name, 'en')).sort()
  }, [projects, groupMode])

  const handleExportDownload = async (format: 'sssom' | 'stcm' | 'usagi') => {
    if (format === 'sssom') {
      // Synthetic project for the cross-project export; exportToSssomTsv only reads name + id.
      const virtualProject = { name: { en: 'global' }, id: 'global' } as unknown as MappingProject
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
              : exportGroupFilter.has(localized(p.name, 'en'))
          }).map((p) => p.id))
        : null

      const filteredProjects = filteredProjectIds
        ? projects.filter((p) => filteredProjectIds.has(p.id))
        : projects

      const allSourceConcepts: { vocabularyId: string; conceptCode: string; conceptName: string }[] = []
      for (const proj of filteredProjects) {
        if (proj.sourceType === 'file') {
          if (proj.fileSourceData?.columnMapping?.conceptIdColumn) continue
          if (proj.fileSourceData) {
            try {
              await mountFileSourceIntoDuckDB(proj.id, proj.fileSourceData.rows, proj.fileSourceData.columnMapping, proj.fileSourceData.rawFileBuffer)
              const dsId = fileSourceDataSourceId(proj.id)
              // queryDataSourceAll + SELECT *: page past the 10k server cap, and
              // vocabulary_id may be absent from the view (see loadSourceConcepts).
              const rows = await queryDataSourceAll(dsId, 'SELECT * FROM source_concepts')
              for (const r of rows) {
                const code = String(r.concept_code ?? '')
                const vocab = String(r.vocabulary_id ?? proj.name)
                const name = String(r.concept_name ?? '')
                if (code) allSourceConcepts.push({ vocabularyId: vocab, conceptCode: code, conceptName: name })
              }
            } catch { /* skip if mount/query fails */ }
          }
        } else {
          const ds = dataSources.find((s) => s.id === proj.dataSourceId)
          if (!ds?.schemaMapping) continue
          try {
            await ensureMounted(ds.id)
            const sql = buildSourceConceptsAllQuery(ds.schemaMapping, {})
            if (!sql) continue
            const rows = await queryDataSourceAll(ds.id, sql)
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
    setSorting((prev) =>
      prev?.columnId === columnId
        ? { columnId, desc: !prev.desc }
        : { columnId, desc: false },
    )
  }

  const updateFilter = (key: keyof GlobalTableFilters, value: string | null | Set<string>) => {
    setColFilters((prev) => ({ ...prev, [key]: value ?? undefined }))
  }

  // Search bar: commit on Enter / button (mirrors the single-project source table).
  useEffect(() => { setPendingSearch(colFilters.globalSearch ?? '') }, [colFilters.globalSearch])
  const commitSearch = () => {
    const term = pendingSearch.trim()
    setColFilters((prev) => ({ ...prev, globalSearch: term || undefined }))
  }
  const clearSearch = () => {
    setPendingSearch('')
    setColFilters((prev) => ({ ...prev, globalSearch: undefined }))
  }

  // Filters popover: source vocabulary + mapped/unmapped status + group labels.
  const statusFilterSet = colFilters.statusFilter ?? new Set<string>()
  const groupLabelsSet = colFilters.groupLabels ?? new Set<string>()
  const popoverGroupOptions = groupMode === 'badge'
    ? allBadgeLabels
    : projects.map((p) => localized(p.name, 'en'))
  const activeFilterCount =
    (colFilters.sourceVocabularyId ? 1 : 0)
    + statusFilterSet.size
    + groupLabelsSet.size

  // ── Badge mode columns ──
  const dedupedColumns = useMemo<ColumnDef<DeduplicatedMappingRow>[]>(() => [
    {
      id: 'status',
      header: () => t('concept_mapping.col_status'),
      accessorFn: (r) => r.isUnmapped ? 'unmapped' : 'mapped',
      cell: ({ row }) => row.original.isUnmapped
        ? <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: STATUS_BAR_COLORS.unmapped }} />
            {t('concept_mapping.filter_unmapped')}
          </span>
        : <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
            <span className="inline-block size-1.5 rounded-full bg-blue-500" />
            {t('concept_mapping.status_mapped')}
          </span>,
      size: 80,
    },
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
      id: 'sourceConceptId',
      header: () => t('concept_mapping.col_source_concept_id'),
      accessorFn: (r) => r.resolvedSourceConceptId,
      sortingFn: 'basic',
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
      id: 'status',
      header: () => t('concept_mapping.col_status'),
      accessorFn: (r) => r.isUnmapped ? 'unmapped' : 'mapped',
      cell: ({ row }) => row.original.isUnmapped
        ? <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: STATUS_BAR_COLORS.unmapped }} />
            {t('concept_mapping.filter_unmapped')}
          </span>
        : <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
            <span className="inline-block size-1.5 rounded-full bg-blue-500" />
            {t('concept_mapping.status_mapped')}
          </span>,
      size: 90,
    },
    {
      id: 'groupLabel',
      header: () => t('concept_mapping.global_project_col'),
      accessorFn: (r) => r.projectName,
      cell: ({ row }) => <span className="truncate text-muted-foreground">{row.original.projectName}</span>,
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
      sortingFn: 'basic',
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

  // Infinite scroll for table tab — use callback ref since Radix TabsContent
  // unmounts/remounts content, so a regular ref + useEffect misses the element.
  const hasMoreRef = useRef(tableHasMore)
  hasMoreRef.current = tableHasMore
  const handleLoadMoreRef = useRef(handleLoadMore)
  handleLoadMoreRef.current = handleLoadMore
  const scrollCleanupRef = useRef<(() => void) | null>(null)

  const scrollContainerRef = useCallback((el: HTMLDivElement | null) => {
    // Clean up previous listener
    if (scrollCleanupRef.current) {
      scrollCleanupRef.current()
      scrollCleanupRef.current = null
    }
    if (!el) return
    const onScroll = () => {
      if (!hasMoreRef.current) return
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
        handleLoadMoreRef.current()
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    scrollCleanupRef.current = () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Active columns depend on groupMode
  const activeColumns = groupMode === 'badge' ? dedupedColumns : flatColumns

  const renderColFilter = (columnId: string) => {
    if (columnId === 'status') {
      const opts = [
        { value: 'mapped', label: t('concept_mapping.status_mapped') },
        { value: 'unmapped', label: t('concept_mapping.filter_unmapped') },
      ]
      return <MultiSelectFilter selected={colFilters.statusFilter ?? new Set()} options={opts} onChange={(v) => updateFilter('statusFilter', v)} />
    }
    if (columnId === 'groupLabel' || columnId === 'badgeLabels') {
      const selected = colFilters.groupLabels ?? new Set<string>()
      if (groupMode === 'badge') {
        const opts = allBadgeLabels.map((l) => ({ value: l, label: l }))
        return opts.length > 0
          ? <MultiSelectFilter selected={selected} options={opts} onChange={(v) => updateFilter('groupLabels', v)} />
          : null
      }
      // project mode: use project names from projects list
      const opts = projects.map((p) => ({ value: localized(p.name, 'en'), label: localized(p.name, 'en') }))
      return opts.length > 0
        ? <MultiSelectFilter selected={selected} options={opts} onChange={(v) => updateFilter('groupLabels', v)} />
        : null
    }
    if (columnId === 'sourceVocabularyId' && allSourceVocabs.length > 0) {
      const opts = allSourceVocabs.map((v) => ({ value: v, label: v }))
      return <ColFilterSelect value={colFilters.sourceVocabularyId ?? null} options={opts} placeholder="..." onChange={(v) => updateFilter('sourceVocabularyId', v)} />
    }
    if (columnId === 'sourceConceptId') return <input className={`${FILTER_INPUT_CLASS} font-mono`} placeholder="..." value={colFilters.sourceConceptId ?? ''} onChange={(e) => updateFilter('sourceConceptId', e.target.value || null)} />
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

  // Map DuckDB snake_case rows → camelCase for column defs
  const mappedDedupRows = useMemo<DeduplicatedMappingRow[]>(() => {
    if (groupMode !== 'badge') return []
    return tableRows.map((r) => ({
      key: String(r.key ?? ''),
      isUnmapped: !!r.is_unmapped,
      resolvedSourceConceptId: r.resolved_source_concept_id != null ? Number(r.resolved_source_concept_id) : undefined,
      sourceVocabularyId: String(r.source_vocabulary_id ?? ''),
      sourceConceptName: String(r.source_concept_name ?? ''),
      sourceConceptCode: String(r.source_concept_code ?? ''),
      equivalence: String(r.equivalence ?? ''),
      targetVocabularyId: String(r.target_vocabulary_id ?? ''),
      targetConceptId: Number(r.target_concept_id ?? 0),
      targetConceptName: String(r.target_concept_name ?? ''),
      votesApproved: Number(r.votes_approved ?? 0),
      votesFlagged: Number(r.votes_flagged ?? 0),
      votesRejected: Number(r.votes_rejected ?? 0),
      projectCount: Number(r.project_count ?? 0),
      badgeLabels: String(r.badge_labels ?? '').split(',').filter(Boolean),
    }))
  }, [tableRows, groupMode])

  const mappedFlatRows = useMemo<GlobalMappingRow[]>(() => {
    if (groupMode === 'badge') return []
    return tableRows.map((r) => ({
      id: String(r.id ?? ''),
      projectId: String(r.project_id ?? ''),
      projectName: String(r.project_name ?? ''),
      isUnmapped: !!r.is_unmapped,
      sourceVocabularyId: String(r.source_vocabulary_id ?? ''),
      sourceConceptId: Number(r.source_concept_id ?? 0),
      resolvedSourceConceptId: r.resolved_source_concept_id != null ? Number(r.resolved_source_concept_id) : undefined,
      sourceConceptCode: String(r.source_concept_code ?? ''),
      sourceConceptName: String(r.source_concept_name ?? ''),
      equivalence: String(r.equivalence ?? ''),
      targetVocabularyId: String(r.target_vocabulary_id ?? ''),
      targetConceptId: Number(r.target_concept_id ?? 0),
      targetConceptName: String(r.target_concept_name ?? ''),
      status: (String(r.status ?? 'unchecked')) as MappingStatus,
      mappedBy: String(r.mapped_by ?? ''),
      createdAt: String(r.created_at ?? ''),
      updatedAt: String(r.updated_at ?? ''),
      reviews: r.reviews_json ? JSON.parse(String(r.reviews_json)) : [],
    // Projection of dynamic DuckDB rows: only the fields the column defs read
    // are selected, so this is a partial ConceptMapping shaped at runtime.
    })) as unknown as GlobalMappingRow[]
  }, [tableRows, groupMode])

  const dedupTable = useReactTable({
    data: mappedDedupRows,
    columns: dedupedColumns,
    state: { columnVisibility, columnSizing },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
  })

  const flatTable = useReactTable({
    data: mappedFlatRows,
    columns: flatColumns,
    state: { columnVisibility, columnSizing },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
  })

  // dedupTable and flatTable have different row types; the render path below is
  // row-type-agnostic (only flexRender + generic cell/header access), so we widen
  // to a single Table type to avoid an unusable union of contexts.
  const activeTable = (groupMode === 'badge' ? dedupTable : flatTable) as unknown as TanstackTable<GlobalMappingRow>

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
                    {totals.uniqueMapped > 0 && (
                      <span className="ml-1 text-sm font-normal text-muted-foreground">
                        ({Math.round((totals.approved / totals.uniqueMapped) * 100)}%)
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
                      <Legend
                        wrapperStyle={{ fontSize: 11 }}
                        formatter={(value) => <span style={{ color: 'var(--color-foreground)' }}>{value}</span>}
                      />
                      {(['approved', 'flagged', 'rejected', 'ignored', 'unchecked', 'unmapped'] as const).map((s) => (
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
                      {groupMode === 'badge' && (
                        <TableHead className="text-right text-xs capitalize">{t('concept_mapping.global_projects')}</TableHead>
                      )}
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
                      // % alignment progress = aligned / total source concepts of the
                      // group. Indicates how much of the source CSV has at least one
                      // mapping created (regardless of approval state).
                      const pct = g.totalSourceConceptsFromStats > 0
                        ? Math.round((g.uniqueSourceConcepts / g.totalSourceConceptsFromStats) * 100)
                        : 0
                      return (
                        <TableRow key={name} className="text-xs">
                          <TableCell className="font-medium">{getDisplayName(name)}</TableCell>
                          {groupMode === 'badge' && (
                            <TableCell className="text-right text-muted-foreground">{g.projectCount}</TableCell>
                          )}
                          <TableCell className="text-right">{g.uniqueSourceConcepts.toLocaleString()}</TableCell>
                          <TableCell className="text-right text-green-600">{g.approved.toLocaleString()}</TableCell>
                          <TableCell className="text-right text-orange-500">{g.flagged.toLocaleString()}</TableCell>
                          <TableCell className="text-right text-red-500">{g.rejected.toLocaleString()}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                                <div className="h-full rounded-full bg-green-500" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="w-9 text-right tabular-nums text-muted-foreground">{pct}%</span>
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
          {/* Toolbar — filters popover + global search, aligned with the single
              project's source-concepts table (SourceConceptTable). */}
          <div className="flex items-center gap-1.5 border-b px-3 py-2">
            <Popover>
              <UiTooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon-sm" className={`h-8 w-8 shrink-0 ${activeFilterCount > 0 ? 'text-primary' : ''}`}>
                      <SlidersHorizontal size={14} />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">{t('common.filters')}</TooltipContent>
              </UiTooltip>
              <PopoverContent align="start" className="w-[260px] space-y-3 p-3" onCloseAutoFocus={(e) => e.preventDefault()}>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">{t('common.filters')}</p>
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() => setColFilters((prev) => ({ ...prev, sourceVocabularyId: undefined, statusFilter: undefined, groupLabels: undefined }))}
                    >
                      {t('common.clear')}
                    </button>
                  )}
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_status')}</label>
                  <SharedMultiSelectFilter
                    value={[...statusFilterSet]}
                    options={[
                      { value: 'mapped', label: t('concept_mapping.status_mapped') },
                      { value: 'unmapped', label: t('concept_mapping.filter_unmapped') },
                    ]}
                    placeholder={t('concepts.filter_all')}
                    onChange={(v) => updateFilter('statusFilter', new Set(v))}
                    triggerClass="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus:border-primary"
                  />
                </div>
                {popoverGroupOptions.length > 0 && (
                  <div className="space-y-1">
                    <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{groupModeLabel}</label>
                    <SharedMultiSelectFilter
                      value={[...groupLabelsSet]}
                      options={popoverGroupOptions}
                      placeholder={t('concepts.filter_all')}
                      onChange={(v) => updateFilter('groupLabels', new Set(v))}
                      triggerClass="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus:border-primary"
                    />
                  </div>
                )}
                {allSourceVocabs.length > 0 && (
                  <div className="space-y-1">
                    <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('concept_mapping.col_vocabulary')}</label>
                    <SharedMultiSelectFilter
                      value={colFilters.sourceVocabularyId ? [colFilters.sourceVocabularyId] : []}
                      options={allSourceVocabs}
                      placeholder={t('concepts.filter_all')}
                      onChange={(v) => updateFilter('sourceVocabularyId', v[v.length - 1] ?? null)}
                      triggerClass="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus:border-primary"
                    />
                  </div>
                )}
              </PopoverContent>
            </Popover>

            <div className="relative flex-1">
              <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={pendingSearch}
                onChange={(e) => setPendingSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitSearch() }}
                placeholder={t('concept_mapping.global_search_placeholder')}
                className="h-8 pl-7 pr-7 text-xs"
              />
              {pendingSearch && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <Button size="sm" className="h-8" onClick={commitSearch}>
              <Search size={13} />
              {t('common.search')}
            </Button>
          </div>

          <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
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
                          {header.column.getCanResize() && (
                            <div
                              onMouseDown={header.getResizeHandler()}
                              onTouchStart={header.getResizeHandler()}
                              onDoubleClick={() => header.column.resetSize()}
                              className="group/resize absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize select-none touch-none"
                            >
                              <div
                                className={`absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 transition-colors ${
                                  header.column.getIsResizing() ? 'bg-primary' : 'bg-transparent group-hover/resize:bg-muted-foreground/40'
                                }`}
                              />
                            </div>
                          )}
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
                {(loadingMappings || loadingSourceConcepts || tablePopulating || (tableLoading && tableRows.length === 0)) ? (
                  <TableRow>
                    <TableCell colSpan={activeColumns.length} className="h-24 text-center text-muted-foreground">
                      {t('concept_mapping.global_loading')}
                    </TableCell>
                  </TableRow>
                ) : tableRows.length === 0 ? (
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
                {tableLoading && tableRows.length > 0 && (
                  <TableRow>
                    <TableCell colSpan={activeColumns.length} className="py-2 text-center text-[10px] text-muted-foreground">
                      {t('common.loading')}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Footer: settings + pagination */}
          <div className="flex items-center border-t px-4 py-1.5">
            <DropdownMenu>
              <UiTooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" className="h-6 w-6">
                      <Settings2 size={12} />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">{t('common.columns')}</TooltipContent>
              </UiTooltip>
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

            <span className="ml-2 text-[10px] text-muted-foreground">
              {t('concept_mapping.global_showing', { shown: tableRows.length.toLocaleString(), total: tableTotalCount.toLocaleString() } as Record<string, string>)}
            </span>
          </div>
        </TabsContent>

        {/* ── EXPORT TAB ── */}
        <TabsContent value="export" className="flex-1 overflow-auto p-4">
          <div className="mx-auto max-w-3xl space-y-4">

            {/* Filter section — one card, two columns: statuses (left) / unmapped + total (right),
                aligned with the single mapping project's Export tab. */}
            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">{t('concept_mapping.export_filter_title')}</p>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => { setExportStatuses(new Set(EXPORT_STATUSES)); setExportIncludeUnmapped(true) }}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    {t('common.select_all')}
                  </button>
                  <span className="text-[10px] text-muted-foreground">/</span>
                  <button
                    type="button"
                    onClick={() => { setExportStatuses(new Set()); setExportIncludeUnmapped(false) }}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    {t('common.select_none')}
                  </button>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 sm:divide-x">
                {/* Left: group-by filter (badges) + status checkboxes */}
                <div className="space-y-3">
                  {exportGroupOptions.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                        {t('concept_mapping.global_group_by')}: <span className="font-normal">{groupModeLabel}</span>
                      </p>
                      <div className="flex flex-wrap gap-1.5">
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
                              className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground'}`}
                            >
                              {opt}
                            </button>
                          )
                        })}
                        {exportGroupFilter.size > 0 && (
                          <button
                            type="button"
                            onClick={() => setExportGroupFilter(new Set())}
                            className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            {t('common.clear')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="space-y-1">
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
                  </div>
                </div>

                {/* Right: unmapped toggle + total */}
                <div className="flex flex-col sm:pl-4">
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={exportIncludeUnmapped}
                      onChange={() => setExportIncludeUnmapped((v) => !v)}
                      className="mt-0.5 size-3.5 rounded border-gray-300 accent-primary"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs">{t('concept_mapping.export_unmapped')}</span>
                        {totals.unmapped > 0 && (
                          <Badge variant="secondary" className="text-[10px]">{totals.unmapped}</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">{t('concept_mapping.export_unmapped_stcm_only')}</p>
                    </div>
                  </label>

                  <div className="mt-auto border-t pt-2">
                    <p className="text-xs text-muted-foreground">
                      {t('concept_mapping.export_total')}: <strong>{exportFilteredMappings.length + (exportIncludeUnmapped ? totals.unmapped : 0)}</strong> {t('concept_mapping.export_mappings_count')}
                    </p>
                  </div>
                </div>
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
                      disabled={exportFilteredMappings.length === 0 && !(exportIncludeUnmapped && totals.unmapped > 0)}
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
