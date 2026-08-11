import { useState, useEffect, useCallback, useRef, useMemo, useTransition } from 'react'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table'
import { Search, Plus, Check, ArrowLeft, Loader2, ChevronLeft, ChevronRight, ChevronDown, Settings2, SlidersHorizontal, MessageSquare, ArrowUpDown, ArrowUp, ArrowDown, EyeOff, Info, Sparkles, Upload, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildStandardConceptSearchQuery } from '@/lib/concept-mapping/mapping-queries'
import { type SuggestionCandidate, getProviderForMethod, computeCombinedScore, pickStrongestEquivalence, pickFirstComment, pickFirstConceptSet, DEFAULT_WEIGHTS, ALL_PROVIDERS, METHOD_DOT_COLORS } from '@/lib/concept-mapping/syntactic-suggestions'
import { SuggestionsTable, DEFAULT_SUGGESTIONS_VIEW, type SuggestionsTableView } from './SuggestionsTable'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Skeleton } from '@/components/ui/skeleton'
import { TruncatedHeader, headerLabel } from '@/components/ui/truncated-header'
import { EQUIV_BADGE, normalizeEquivalence } from '@/lib/concept-mapping/equivalence-badge'
import { getConceptSetI18n } from '@/lib/concept-mapping/i18n'
import { EquivalenceMenuItems, EquivalencePickerButton } from './EquivalenceMenuItems'
import { ConceptSetDetailSheet } from '../ConceptSetDetailSheet'
import { ConceptDetailSheet, type ConceptInfoTarget } from './ConceptDetailSheet'
import { StandardConceptBadge } from '@/lib/concept-mapping/standard-concept-badge'
import { ValidityBadge } from '@/lib/concept-mapping/validity-badge'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useSuggestionScoresStore } from '@/stores/suggestion-scores-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import { useRequireIdentity } from './IdentityRequiredDialog'
import type { MappingProject, DataSource, MappingEquivalence, ConceptSet, ResolvedConcept } from '@/types'
import type { SourceConceptRow } from '../MappingEditorTab'

interface TargetConceptPanelProps {
  project: MappingProject
  dataSource?: DataSource
  sourceConcept: SourceConceptRow | null
  /** Set of source concept IDs marked as ignored (derived from mappings). */
  ignoredConceptIds: Set<number>
  onGoToConceptSets?: () => void
}

interface SearchResult {
  concept_id: number
  concept_name: string
  concept_code: string
  vocabulary_id: string
  domain_id?: string
  concept_class_id?: string
  standard_concept?: string
  invalid_reason?: string | null
}

/** Derive the resolved concept set URL from the source URL. */
function getResolvedUrl(sourceUrl?: string): string | null {
  if (!sourceUrl) return null
  if (!sourceUrl.includes('/concept_sets/')) return null
  return sourceUrl.replace('/concept_sets/', '/concept_sets_resolved/')
}

const CS_PAGE_SIZE = 50
const RESOLVED_PAGE_SIZE = 50

/** Placeholder shown while a tab switch's heavy table mounts in a transition. */
function TabSkeleton() {
  return (
    <div className="flex h-full flex-col gap-1.5 p-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  )
}

/** Small dropdown for categorical column filters with search. */
function ColumnFilterSelect({
  value,
  options,
  placeholder,
  onChange,
  triggerClass,
}: {
  value: string | null
  options: string[]
  placeholder: string
  onChange: (v: string | null) => void
  triggerClass?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const filtered = search ? options.filter((o) => o.toLowerCase().includes(search.toLowerCase())) : options

  const select = (v: string | null) => { onChange(v); setOpen(false) }

  return (
    <DropdownMenu open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch('') }}>
      <DropdownMenuTrigger asChild>
        <button className={triggerClass ?? 'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-left text-[10px] outline-none truncate focus:border-primary'}>
          <span className={`truncate ${value ? 'text-foreground' : 'text-muted-foreground'}`}>{value ?? placeholder}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[200px]"
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => { e.detail.originalEvent.stopPropagation() }}
      >
        <div className="px-2 py-1.5">
          <input
            autoFocus
            className="h-6 w-full rounded border bg-transparent px-1.5 text-[11px] outline-none placeholder:text-muted-foreground focus:border-primary"
            placeholder={t('common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                if (filtered.length === 1) select(filtered[0])
                else if (filtered.length === 0) select(null)
                else setOpen(false)
              }
            }}
          />
        </div>
        <DropdownMenuSeparator />
        <div className="max-h-72 overflow-auto">
          <DropdownMenuItem className="text-xs" onSelect={() => select(null)}>
            {t('concepts.filter_all')}
          </DropdownMenuItem>
          {filtered.map((opt) => (
            <DropdownMenuItem
              key={opt}
              className={`text-xs ${value === opt ? 'bg-accent font-medium' : ''}`}
              onSelect={() => select(opt)}
            >
              {opt}
            </DropdownMenuItem>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-1.5 text-[10px] text-muted-foreground">{t('common.no_results')}</p>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const RESOLVED_FILTER_INPUT = 'h-5 w-full rounded border border-dashed bg-transparent px-1 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

/** Multi-select dropdown for resolved concept column filters.
 *  Thin `Set`-based adapter over the shared {@link MultiSelectFilter} so every
 *  column filter across the app renders identically. */
function ResolvedMultiSelect({
  options,
  selected,
  onChange,
  triggerClass,
}: {
  options: string[]
  selected?: Set<string>
  onChange: (v: Set<string>) => void
  triggerClass?: string
}) {
  if (options.length === 0) return <span />
  return (
    <MultiSelectFilter
      options={options}
      value={selected ? [...selected] : []}
      onChange={(next) => onChange(new Set(next))}
      placeholder="..."
      triggerClass={triggerClass ?? `${RESOLVED_FILTER_INPUT} justify-between`}
      popoverWidthClass="w-[220px]"
    />
  )
}

/** Fuzzy match: all query characters appear in order in the target. */

export function TargetConceptPanel({ project, dataSource, sourceConcept, ignoredConceptIds, onGoToConceptSets }: TargetConceptPanelProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const { mappings, conceptSets, createMapping, updateMapping, deleteMapping } = useConceptMappingStore()
  const getUserDisplayName = useAppStore((s) => s.getUserDisplayName)
  const getAuthorDetails = useAppStore((s) => s.getAuthorDetails)
  const allDataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const { requireIdentity, dialog: identityDialog } = useRequireIdentity()

  // Search for mapping
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

  // Search pre-filters (applied server-side in the SQL query)
  const [searchFilterVocabs, setSearchFilterVocabs] = useState<Set<string>>(new Set())
  const [searchFilterDomains, setSearchFilterDomains] = useState<Set<string>>(new Set())
  const [searchFilterClasses, setSearchFilterClasses] = useState<Set<string>>(new Set())
  const [searchFilterStandard, setSearchFilterStandard] = useState<Set<string>>(new Set())
  const [searchMaxResults, setSearchMaxResults] = useState(1000)
  const [searchFilterOptions, setSearchFilterOptions] = useState<{ vocabs: string[]; domains: string[]; classes: string[]; standards: string[] }>({ vocabs: [], domains: [], classes: [], standards: [] })

  // "Map with comment" dialog
  const [commentDialogOpen, setCommentDialogOpen] = useState(false)
  const [commentEquivalence, setCommentEquivalence] = useState<MappingEquivalence>('skos:exactMatch')
  // `selectedEquivalence` is what the add button uses right now; `manualEquivalence` is
  // the user's sticky preference set via the dropdown. Clicking a suggestion overrides
  // `selectedEquivalence` with the suggestion's value for that target only; selecting a
  // non-suggestion target (Search / Concept sets) restores the manual preference.
  const [selectedEquivalence, setSelectedEquivalence] = useState<MappingEquivalence>('skos:exactMatch')
  const [manualEquivalence, setManualEquivalence] = useState<MappingEquivalence>('skos:exactMatch')
  const pickManualEquivalence = useCallback((pred: MappingEquivalence) => {
    setManualEquivalence(pred)
    setSelectedEquivalence(pred)
  }, [])
  const equivButtonGroupRef = useRef<HTMLDivElement>(null)
  const [equivDropdownWidth, setEquivDropdownWidth] = useState<number | undefined>(undefined)
  const [commentText, setCommentText] = useState('')

  // "Ignore with comment" dialog
  const [ignoreDialogOpen, setIgnoreDialogOpen] = useState(false)
  const [ignoreCommentText, setIgnoreCommentText] = useState('')

  // Browse mode state
  const [csFilterCategory, setCsFilterCategory] = useState<Set<string>>(new Set())
  const [csFilterSubcategory, setCsFilterSubcategory] = useState<Set<string>>(new Set())
  const [csFilterName, setCsFilterName] = useState('')
  const [csPage, setCsPage] = useState(0)

  // Selected concept set for resolved view
  const [selectedCs, setSelectedCs] = useState<ConceptSet | null>(null)
  const selectedCsTr = useMemo(
    () => selectedCs ? getConceptSetI18n(selectedCs, lang) : { name: '', description: '', category: undefined, subcategory: undefined },
    [selectedCs, lang],
  )
  const [detailSheetOpen, setDetailSheetOpen] = useState(false)
  const [detailSheetCs, setDetailSheetCs] = useState<ConceptSet | null>(null)
  const [resolvedConcepts, setResolvedConcepts] = useState<ResolvedConcept[]>([])
  const [resolvedLoading, setResolvedLoading] = useState(false)
  const [resolvedError, setResolvedError] = useState<string | null>(null)
  const [resolvedSearch, setResolvedSearch] = useState('')
  const [resolvedPage, setResolvedPage] = useState(0)
  const [resolvedFilters, setResolvedFilters] = useState<{
    name?: string; id?: string; code?: string
    vocab?: Set<string>; domain?: Set<string>; class?: Set<string>; std?: Set<string>
  }>({})
  const [resolvedColVisibility, setResolvedColVisibility] = useState({ vocab: true, id: false, name: true, code: false, domain: false, class: false, std: true })

  // Browse mode toggle. `browseMode` is the urgent value driving the tab highlight
  // and action bar (painted instantly on click); `deferredBrowseMode` decides which
  // (potentially heavy) table actually mounts and is updated inside a transition, so
  // the click paints before the table mount blocks the main thread.
  const [browseMode, setBrowseMode] = useState<'concept_sets' | 'search' | 'suggestions'>('search')
  const [deferredBrowseMode, setDeferredBrowseMode] = useState<'concept_sets' | 'search' | 'suggestions'>('search')
  const [tabPending, startTabTransition] = useTransition()
  const switchBrowseMode = useCallback((mode: 'concept_sets' | 'search' | 'suggestions') => {
    setBrowseMode(mode)
    setSelectedTarget(null)
    startTabTransition(() => setDeferredBrowseMode(mode))
  }, [])

  // Persisted suggestions-table view (column visibility / sort / sizing). Held here,
  // not inside SuggestionsTable, so it survives that table unmounting while the
  // suggestions reload on a source-concept change (otherwise the columns reset).
  const [suggestionsView, setSuggestionsView] = useState<SuggestionsTableView>(DEFAULT_SUGGESTIONS_VIEW)

  // Suggestions state (from imported scores)
  const [suggestionsImporting, setSuggestionsImporting] = useState(false)
  const [suggestionsImportError, setSuggestionsImportError] = useState<string | null>(null)
  const suggestionsFileInputRef = useRef<HTMLInputElement>(null)
  const [weights, setWeights] = useState<Record<string, number>>({ ...DEFAULT_WEIGHTS })
  const [suggestionsSettingsOpen, setSuggestionsSettingsOpen] = useState(false)
  const [suggestionsDeleteConfirmOpen, setSuggestionsDeleteConfirmOpen] = useState(false)

  // Concept detail sheet
  const [conceptDetailOpen, setConceptDetailOpen] = useState(false)
  const [conceptDetailTarget, setConceptDetailTarget] = useState<ConceptInfoTarget | null>(null)

  // Selected target concept (for resolved concepts or search results)
  const [selectedTarget, setSelectedTarget] = useState<{ conceptId: number; conceptName: string; vocabularyId: string; domainId: string; conceptCode: string; conceptClassId?: string; standardConcept?: string } | null>(null)

  // Clear selected target when source concept changes, and reset the add-button
  // equivalence to the sticky manual preference — otherwise a value carried over from
  // a previously clicked suggestion (e.g. "Close") would stick on the next concept.
  // Read the manual preference via a ref so changing it from the dropdown doesn't
  // re-run this effect (which would clear the current selection).
  const manualEquivalenceRef = useRef(manualEquivalence)
  manualEquivalenceRef.current = manualEquivalence
  useEffect(() => {
    setSelectedTarget(null)
    setSelectedEquivalence(manualEquivalenceRef.current)
  }, [sourceConcept?.concept_id])

  // Active vocabulary data source + concept table name (shared for detail sheet)
  const vocabDsInfo = useMemo(() => {
    const vocabDs = project.vocabularyDataSourceId
      ? allDataSources.find((ds) => ds.id === project.vocabularyDataSourceId)
      : null
    const ds = vocabDs ?? dataSource
    const mapping = ds?.schemaMapping
    const dict = (mapping?.conceptTables ?? [])[0]
    return { dsId: ds?.id, conceptTable: dict?.table ?? 'concept' }
  }, [project.vocabularyDataSourceId, allDataSources, dataSource])

  // Linked concept sets
  const linkedSets = conceptSets.filter((cs) => (project.conceptSetIds ?? []).includes(cs.id))

  // Data-dictionary concept sets keyed by their stable cross-install uniqueId,
  // so an AI suggestion carrying a concept_set_uid can open the set locally.
  // Matches across the whole workspace, not just sets linked to this project.
  const conceptSetsByUid = useMemo(() => {
    const m = new Map<string, ConceptSet>()
    for (const cs of conceptSets) if (cs.uniqueId) m.set(cs.uniqueId, cs)
    return m
  }, [conceptSets])
  const conceptSetNamesByUid = useMemo(() => {
    const m = new Map<string, string>()
    for (const cs of conceptSets) if (cs.uniqueId) m.set(cs.uniqueId, getConceptSetI18n(cs, lang).name)
    return m
  }, [conceptSets, lang])

  // "Concept set not imported locally" prompt (offers import via sourceRepo).
  const [csNotLocal, setCsNotLocal] = useState<{ uid: string; sourceRepo: string | null } | null>(null)


  // Existing mappings for selected source concept (match by ID or by code for code-only tables)
  const existingMappings = sourceConcept
    ? mappings.filter((m) =>
        m.sourceConceptId === sourceConcept.concept_id ||
        (m.sourceConceptCode && sourceConcept.concept_code && m.sourceConceptCode === sourceConcept.concept_code)
      )
    : []

  // The mapping the selected target already has, if any: selecting an already-mapped
  // target switches the action bar from "add" to "edit the existing mapping".
  const selectedTargetMapping = selectedTarget
    ? existingMappings.find((m) => m.targetConceptId === selectedTarget.conceptId) ?? null
    : null
  // A mapping that has been reviewed or commented is frozen: changing its equivalence
  // (or deleting it) would silently invalidate someone else's assessment.
  const selectedTargetMappingLocked = !!selectedTargetMapping &&
    ((selectedTargetMapping.reviews?.length ?? 0) > 0 || (selectedTargetMapping.comments?.length ?? 0) > 0)

  // Unique dropdown options for category, subcategory, provenance
  const csCategoryOptions = useMemo(() => [...new Set(linkedSets.map((cs) => getConceptSetI18n(cs, lang).category).filter(Boolean) as string[])].sort(), [linkedSets, lang])
  const csSubcategoryOptions = useMemo(() => [...new Set(linkedSets.map((cs) => getConceptSetI18n(cs, lang).subcategory).filter(Boolean) as string[])].sort(), [linkedSets, lang])
  const csProvenanceOptions = useMemo(() => [...new Set(linkedSets.map((cs) => cs.provenance).filter(Boolean) as string[])].sort(), [linkedSets])

  // Filter concept sets by column filters
  const filteredCs = linkedSets.filter((cs) => {
    const tr = getConceptSetI18n(cs, lang)
    if (csFilterCategory.size > 0 && !csFilterCategory.has(tr.category ?? '')) return false
    if (csFilterSubcategory.size > 0 && !csFilterSubcategory.has(tr.subcategory ?? '')) return false
    if (csFilterName && !tr.name.toLowerCase().includes(csFilterName.toLowerCase())) return false
    return true
  })

  // csTotalPages and csPageItems computed in renderConceptSetsBrowse via fullyFilteredCs

  // Reset cs page when filters change
  const prevFiltersRef = useRef({ csFilterCategory, csFilterSubcategory, csFilterName })
  if (
    prevFiltersRef.current.csFilterCategory !== csFilterCategory ||
    prevFiltersRef.current.csFilterSubcategory !== csFilterSubcategory ||
    prevFiltersRef.current.csFilterName !== csFilterName
  ) {
    prevFiltersRef.current = { csFilterCategory, csFilterSubcategory, csFilterName }
    if (csPage !== 0) setCsPage(0)
  }

  // Load resolved concepts when a concept set is selected
  const loadResolved = useCallback(async (cs: ConceptSet) => {
    setResolvedConcepts([])
    setResolvedError(null)
    setResolvedSearch('')
    setResolvedPage(0)

    const url = getResolvedUrl(cs.sourceUrl)
    if (!url) {
      // Fall back to expression items as "resolved"
      setResolvedConcepts(
        cs.expression.items
          .filter((item) => !item.isExcluded)
          .map((item) => ({
            conceptId: item.concept.conceptId,
            conceptName: item.concept.conceptName,
            vocabularyId: item.concept.vocabularyId,
            domainId: item.concept.domainId,
            conceptClassId: item.concept.conceptClassId,
            conceptCode: item.concept.conceptCode,
            standardConcept: item.concept.standardConcept,
          })),
      )
      return
    }

    setResolvedLoading(true)
    try {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = await resp.json()
      const obj = json as Record<string, unknown>
      const items = obj.resolvedConcepts as Record<string, unknown>[] | undefined
      if (!Array.isArray(items)) throw new Error('Invalid format')

      setResolvedConcepts(
        items.map((c) => ({
          conceptId: Number(c.conceptId ?? c.concept_id ?? 0),
          conceptName: String(c.conceptName ?? c.concept_name ?? ''),
          vocabularyId: String(c.vocabularyId ?? c.vocabulary_id ?? ''),
          domainId: String(c.domainId ?? c.domain_id ?? ''),
          conceptClassId: String(c.conceptClassId ?? c.concept_class_id ?? ''),
          conceptCode: String(c.conceptCode ?? c.concept_code ?? ''),
          standardConcept: (c.standardConcept ?? c.standard_concept ?? null) as string | null,
        })),
      )
    } catch (err) {
      setResolvedError(err instanceof Error ? err.message : String(err))
    } finally {
      setResolvedLoading(false)
    }
  }, [])

  // When selecting a concept set, load its resolved concepts
  const handleSelectCs = useCallback((cs: ConceptSet) => {
    setSelectedCs(cs)
    loadResolved(cs)
  }, [loadResolved])

  // Filter resolved concepts
  const resolvedFilterOptions = useMemo(() => ({
    vocab: [...new Set(resolvedConcepts.map((c) => c.vocabularyId).filter(Boolean))].sort(),
    domain: [...new Set(resolvedConcepts.map((c) => c.domainId).filter(Boolean))].sort(),
    class: [...new Set(resolvedConcepts.map((c) => c.conceptClassId).filter(Boolean) as string[])].sort(),
    std: [...new Set(resolvedConcepts.map((c) => c.standardConcept).filter(Boolean) as string[])].sort(),
  }), [resolvedConcepts])

  const filteredResolved = useMemo(() => {
    const q = resolvedSearch.trim().toLowerCase()
    const f = resolvedFilters
    return resolvedConcepts.filter((c) => {
      if (q && !(
        c.conceptName.toLowerCase().includes(q) ||
        String(c.conceptId).includes(q) ||
        c.vocabularyId.toLowerCase().includes(q) ||
        c.domainId.toLowerCase().includes(q)
      )) return false
      if (f.name && !c.conceptName.toLowerCase().includes(f.name.toLowerCase())) return false
      if (f.id && !String(c.conceptId).includes(f.id)) return false
      if (f.code && !c.conceptCode?.toLowerCase().includes(f.code.toLowerCase())) return false
      if (f.vocab?.size && !f.vocab.has(c.vocabularyId)) return false
      if (f.domain?.size && !f.domain.has(c.domainId)) return false
      if (f.class?.size && !f.class.has(c.conceptClassId ?? '')) return false
      if (f.std?.size && !f.std.has(c.standardConcept ?? '')) return false
      return true
    })
  }, [resolvedConcepts, resolvedSearch, resolvedFilters])

  const resolvedTotalPages = Math.max(1, Math.ceil(filteredResolved.length / RESOLVED_PAGE_SIZE))
  const resolvedPageItems = filteredResolved.slice(
    resolvedPage * RESOLVED_PAGE_SIZE,
    (resolvedPage + 1) * RESOLVED_PAGE_SIZE,
  )

  // Load distinct filter options for the search pre-filters
  useEffect(() => {
    const vocabDs = project.vocabularyDataSourceId
      ? allDataSources.find((ds) => ds.id === project.vocabularyDataSourceId)
      : null
    const targetDsId = vocabDs?.id ?? dataSource?.id
    const targetMapping = vocabDs?.schemaMapping ?? dataSource?.schemaMapping
    if (!targetDsId || !targetMapping) return
    const dict = (targetMapping.conceptTables ?? [])[0]
    if (!dict) return
    const vocabCol = dict.terminologyIdColumn ?? dict.vocabularyColumn ?? 'vocabulary_id'
    const domainCol = dict.extraColumns?.domain_id ?? dict.categoryColumn
    const classCol = dict.extraColumns?.concept_class_id ?? dict.subcategoryColumn
    const stdCol = dict.extraColumns?.standard_concept
    const parts: string[] = []
    parts.push(`SELECT DISTINCT d.${vocabCol} AS v FROM ${dict.table} d WHERE d.${vocabCol} IS NOT NULL ORDER BY v`)
    if (domainCol) parts.push(`SELECT DISTINCT d.${domainCol} AS v FROM ${dict.table} d WHERE d.${domainCol} IS NOT NULL ORDER BY v`)
    if (classCol) parts.push(`SELECT DISTINCT d.${classCol} AS v FROM ${dict.table} d WHERE d.${classCol} IS NOT NULL ORDER BY v`)
    if (stdCol) parts.push(`SELECT DISTINCT d.${stdCol} AS v FROM ${dict.table} d WHERE d.${stdCol} IS NOT NULL ORDER BY v`)
    ;(async () => {
      try {
        await ensureMounted(targetDsId)
        const results = await Promise.all(parts.map((sql) => queryDataSource(targetDsId, sql)))
        const toArr = (rows: Record<string, unknown>[]) => rows.map((r) => String(r.v)).filter(Boolean).sort()
        let idx = 0
        const vocabs = toArr(results[idx++])
        const domains = domainCol ? toArr(results[idx++]) : []
        const classes = classCol ? toArr(results[idx++]) : []
        const standards = stdCol ? toArr(results[idx++]) : []
        setSearchFilterOptions({ vocabs, domains, classes, standards })
      } catch {
        // Silently fail — filter options remain empty
      }
    })()
  }, [project.vocabularyDataSourceId, dataSource, allDataSources, ensureMounted])

  // Reset resolved page when filters change
  useEffect(() => {
    setResolvedPage(0)
  }, [resolvedSearch, resolvedFilters])

  const [searchWarningOpen, setSearchWarningOpen] = useState(false)

  const runSearch = useCallback(async () => {
    const vocabDs = project.vocabularyDataSourceId
      ? allDataSources.find((ds) => ds.id === project.vocabularyDataSourceId)
      : null
    const targetDsId = vocabDs?.id ?? dataSource?.id
    const targetMapping = vocabDs?.schemaMapping ?? dataSource?.schemaMapping
    if (!targetDsId || !targetMapping) return
    setSearching(true)
    try {
      await ensureMounted(targetDsId)
      const filters = {
        vocabularyIds: searchFilterVocabs.size > 0 ? [...searchFilterVocabs] : undefined,
        domainIds: searchFilterDomains.size > 0 ? [...searchFilterDomains] : undefined,
        conceptClassIds: searchFilterClasses.size > 0 ? [...searchFilterClasses] : undefined,
        standardConcepts: searchFilterStandard.size > 0 ? [...searchFilterStandard] : undefined,
      }
      const sql = buildStandardConceptSearchQuery(targetMapping, searchTerm.trim(), filters, searchMaxResults)
      if (!sql) { setSearching(false); return }
      const results = await queryDataSource(targetDsId, sql)
      setSearchResults(results as unknown as SearchResult[])
      setSearchPage(0)
    } catch (err) {
      console.error('Search failed:', err)
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [searchTerm, dataSource, project.vocabularyDataSourceId, allDataSources, ensureMounted, searchFilterVocabs, searchFilterDomains, searchFilterClasses, searchFilterStandard, searchMaxResults])

  /** Submit handler. If the user typed a term but didn't pick any filter, warn first
   *  before launching what may be a multi-second scan over the entire vocabulary. */
  const handleSearch = useCallback(() => {
    const noFilter =
      searchFilterVocabs.size === 0 &&
      searchFilterDomains.size === 0 &&
      searchFilterClasses.size === 0 &&
      searchFilterStandard.size === 0
    if (searchTerm.trim() && noFilter) {
      setSearchWarningOpen(true)
      return
    }
    void runSearch()
  }, [searchTerm, searchFilterVocabs, searchFilterDomains, searchFilterClasses, searchFilterStandard, runSearch])

  const confirmUnfilteredSearch = useCallback(() => {
    setSearchWarningOpen(false)
    void runSearch()
  }, [runSearch])

  /** Add mapping from the selected target concept with a given predicate and optional comment. */
  const handleAddSelectedMapping = async (predicate: MappingEquivalence = 'skos:exactMatch', comment = '') => {
    if (!sourceConcept || !selectedTarget) return
    const alreadyMapped = existingMappings.some((m) => m.targetConceptId === selectedTarget.conceptId)
    if (alreadyMapped) return
    if (!requireIdentity()) return
    const now = new Date().toISOString()
    // createMapping updates state optimistically and persists in the background;
    // clearing the selection immediately keeps the interaction instant. On persistence
    // failure the store rolls back the optimistic insert, so we only log here.
    setSelectedTarget(null)
    createMapping({
      id: crypto.randomUUID(),
      projectId: project.id,
      sourceConceptId: sourceConcept.concept_id,
      sourceConceptName: sourceConcept.concept_name,
      sourceVocabularyId: sourceConcept.vocabulary_id ?? '',
      sourceDomainId: sourceConcept.domain_id ?? '',
      sourceConceptCode: sourceConcept.concept_code ?? '',
      sourceFrequency: sourceConcept.record_count,
      sourceCategoryId: sourceConcept.category,
      sourceSubcategoryId: sourceConcept.subcategory,
      sourceConceptClassId: sourceConcept.concept_class_id,
      targetConceptId: selectedTarget.conceptId,
      targetConceptName: selectedTarget.conceptName,
      targetVocabularyId: selectedTarget.vocabularyId,
      targetDomainId: selectedTarget.domainId,
      targetConceptCode: selectedTarget.conceptCode,
      targetConceptClassId: selectedTarget.conceptClassId,
      targetStandardConcept: selectedTarget.standardConcept,
      conceptSetId: selectedCs?.id,
      mappingType: 'maps_to',
      equivalence: predicate,
      status: 'unchecked',
      comments: comment ? [{
        id: crypto.randomUUID(),
        authorId: getUserDisplayName(),
        authorDetails: getAuthorDetails(),
        text: comment,
        createdAt: now,
      }] : undefined,
      mappedBy: getUserDisplayName(),
      mappedByDetails: getAuthorDetails(),
      mappedOn: now,
      createdAt: now,
      updatedAt: now,
    }).catch((err) => console.error('Failed to persist mapping', err))
  }

  /** Change the equivalence of the mapping the selected target already has. */
  const handleChangeSelectedEquivalence = async (predicate: MappingEquivalence) => {
    if (!selectedTargetMapping || selectedTargetMappingLocked) return
    if (!requireIdentity()) return
    setSelectedEquivalence(predicate)
    updateMapping(selectedTargetMapping.id, { equivalence: predicate, updatedAt: new Date().toISOString() })
      .catch((err) => console.error('Failed to update mapping equivalence', err))
  }

  /** Remove the mapping the selected target already has. */
  const handleRemoveSelectedMapping = async () => {
    if (!selectedTargetMapping || selectedTargetMappingLocked) return
    setSelectedTarget(null)
    deleteMapping(selectedTargetMapping.id).catch((err) => console.error('Failed to delete mapping', err))
  }

  /** Align the current source concept onto a resolved concept-set concept (from
   *  the concept-set detail sheet), mirroring handleAddSelectedMapping. */
  const alignResolvedConcept = useCallback(async (target: ResolvedConcept, predicate: MappingEquivalence) => {
    if (!sourceConcept) return
    if (existingMappings.some((m) => m.targetConceptId === target.conceptId)) return
    if (!requireIdentity()) return
    const now = new Date().toISOString()
    createMapping({
      id: crypto.randomUUID(),
      projectId: project.id,
      sourceConceptId: sourceConcept.concept_id,
      sourceConceptName: sourceConcept.concept_name,
      sourceVocabularyId: sourceConcept.vocabulary_id ?? '',
      sourceDomainId: sourceConcept.domain_id ?? '',
      sourceConceptCode: sourceConcept.concept_code ?? '',
      sourceFrequency: sourceConcept.record_count,
      sourceCategoryId: sourceConcept.category,
      sourceSubcategoryId: sourceConcept.subcategory,
      sourceConceptClassId: sourceConcept.concept_class_id,
      targetConceptId: target.conceptId,
      targetConceptName: target.conceptName,
      targetVocabularyId: target.vocabularyId,
      targetDomainId: target.domainId,
      targetConceptCode: target.conceptCode,
      targetConceptClassId: target.conceptClassId,
      targetStandardConcept: target.standardConcept ?? undefined,
      mappingType: 'maps_to',
      equivalence: predicate,
      status: 'unchecked',
      mappedBy: getUserDisplayName(),
      mappedByDetails: getAuthorDetails(),
      mappedOn: now,
      createdAt: now,
      updatedAt: now,
    }).catch((err) => console.error('Failed to persist mapping', err))
  }, [sourceConcept, existingMappings, requireIdentity, createMapping, project.id, getUserDisplayName, getAuthorDetails])

  /** Submit from the "Map with comment" dialog. */
  const handleCommentDialogSubmit = () => {
    handleAddSelectedMapping(commentEquivalence, commentText.trim())
    setCommentDialogOpen(false)
    setCommentText('')
    setCommentEquivalence('skos:exactMatch')
  }

  /** Toggle ignored status: create or delete the ignored mapping. */
  const handleToggleIgnored = async (comment = '') => {
    if (!sourceConcept) return
    const isIgnored = ignoredConceptIds.has(sourceConcept.concept_id)
    if (isIgnored) {
      // Remove the ignored mapping
      const ignoredMapping = mappings.find(
        (m) => m.sourceConceptId === sourceConcept.concept_id && m.status === 'ignored',
      )
      if (ignoredMapping) await deleteMapping(ignoredMapping.id)
    } else {
      if (!requireIdentity()) return
      // Create an ignored mapping (targetConceptId=0)
      const now = new Date().toISOString()
      createMapping({
        id: crypto.randomUUID(),
        projectId: project.id,
        sourceConceptId: sourceConcept.concept_id,
        sourceConceptName: sourceConcept.concept_name,
        sourceVocabularyId: sourceConcept.vocabulary_id ?? '',
        sourceDomainId: sourceConcept.domain_id ?? '',
        sourceConceptCode: sourceConcept.concept_code ?? '',
        sourceFrequency: sourceConcept.record_count,
        sourceCategoryId: sourceConcept.category,
        sourceSubcategoryId: sourceConcept.subcategory,
        sourceConceptClassId: sourceConcept.concept_class_id,
        targetConceptId: 0,
        targetConceptName: '',
        targetVocabularyId: '',
        targetDomainId: '',
        targetConceptCode: '',
        equivalence: 'skos:exactMatch',
        status: 'ignored',
        comments: comment ? [{
          id: crypto.randomUUID(),
          authorId: getUserDisplayName(),
          authorDetails: getAuthorDetails(),
          text: comment,
          createdAt: now,
        }] : undefined,
        mappedBy: getUserDisplayName(),
        mappedByDetails: getAuthorDetails(),
        mappedOn: now,
        createdAt: now,
        updatedAt: now,
      }).catch((err) => console.error('Failed to persist ignored mapping', err))
    }
  }

  /** Submit from the "Ignore with comment" dialog. */
  const handleIgnoreDialogSubmit = () => {
    handleToggleIgnored(ignoreCommentText.trim())
    setIgnoreDialogOpen(false)
    setIgnoreCommentText('')
  }

  // ─── Concept sets datatable (browse view) ───────────────────────────

  // Filters for additional concept set columns
  const [csFilterVersion, setCsFilterVersion] = useState('')
  const [csFilterProvenance, setCsFilterProvenance] = useState('')

  // TanStack table state for concept sets browse
  const [csColVisibility, setCsColVisibility] = useState<VisibilityState>({
    items: false,
    version: false,
    provenance: false,
  })
  const [csColSizing, setCsColSizing] = useState<Record<string, number>>({})
  const [csSorting, setCsSorting] = useState<{ columnId: string; desc: boolean } | null>(null)

  // Reset cs page when provenance/version filters change too
  const prevExtraFiltersRef = useRef({ csFilterVersion, csFilterProvenance })
  if (prevExtraFiltersRef.current.csFilterVersion !== csFilterVersion || prevExtraFiltersRef.current.csFilterProvenance !== csFilterProvenance) {
    prevExtraFiltersRef.current = { csFilterVersion, csFilterProvenance }
    setCsPage(0)
  }

  /** Translated row for the concept sets browse table. */
  interface CsBrowseRow {
    id: string
    category: string
    subcategory: string
    name: string
    items: number
    version: string
    provenance: string
    raw: ConceptSet
  }

  // Build translated rows
  const csBrowseRows = useMemo<CsBrowseRow[]>(() => {
    return filteredCs
      .filter((cs) => {
        if (csFilterVersion && !(cs.version ?? '').toLowerCase().includes(csFilterVersion.toLowerCase())) return false
        if (csFilterProvenance && (cs.provenance ?? '') !== csFilterProvenance) return false
        return true
      })
      .map((cs) => {
        const tr = getConceptSetI18n(cs, lang)
        return {
          id: cs.id,
          category: tr.category ?? '',
          subcategory: tr.subcategory ?? '',
          name: tr.name,
          items: cs.expression.items.length,
          version: cs.version ?? '',
          provenance: cs.provenance ?? '',
          raw: cs,
        }
      })
  }, [filteredCs, csFilterVersion, csFilterProvenance, lang])

  // Apply sorting
  const csSortedRows = useMemo(() => {
    if (!csSorting) return csBrowseRows
    const col = csSorting.columnId as keyof CsBrowseRow
    const dir = csSorting.desc ? -1 : 1
    return [...csBrowseRows].sort((a, b) => {
      const va = a[col] ?? ''
      const vb = b[col] ?? ''
      if (typeof va === 'number' && typeof vb === 'number') return dir * (va - vb)
      return dir * String(va).localeCompare(String(vb))
    })
  }, [csBrowseRows, csSorting])

  const csFullTotalPages = Math.max(1, Math.ceil(csSortedRows.length / CS_PAGE_SIZE))
  const csFullPageItems = csSortedRows.slice(csPage * CS_PAGE_SIZE, (csPage + 1) * CS_PAGE_SIZE)

  const handleCsSort = (columnId: string) => {
    if (csSorting?.columnId === columnId) {
      if (csSorting.desc) setCsSorting({ columnId, desc: false })
      else setCsSorting(null)
    } else {
      setCsSorting({ columnId, desc: true })
    }
  }

  const FILTER_INPUT_CLASS = 'h-5 w-full rounded border border-dashed bg-transparent px-1 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

  const CS_FILTER_TRIGGER = 'h-5 w-full rounded border border-dashed bg-transparent px-1 text-left text-[10px] outline-none truncate focus:border-primary'

  const renderCsFilter = (columnId: string) => {
    // No concept sets linked → no rows to filter against, so suppress every filter
    // input. Mirrors the implicit behavior of the multi-selects which already hide
    // when their option lists are empty.
    if (linkedSets.length === 0) return null
    if (columnId === 'category' && csCategoryOptions.length > 0) return (
      <ResolvedMultiSelect options={csCategoryOptions} selected={csFilterCategory} onChange={setCsFilterCategory} triggerClass={CS_FILTER_TRIGGER} />
    )
    if (columnId === 'subcategory' && csSubcategoryOptions.length > 0) return (
      <ResolvedMultiSelect options={csSubcategoryOptions} selected={csFilterSubcategory} onChange={setCsFilterSubcategory} triggerClass={CS_FILTER_TRIGGER} />
    )
    if (columnId === 'name') return <input className={FILTER_INPUT_CLASS} placeholder="..." value={csFilterName} onChange={(e) => setCsFilterName(e.target.value)} />
    if (columnId === 'version') return <input className={FILTER_INPUT_CLASS} placeholder="..." value={csFilterVersion} onChange={(e) => setCsFilterVersion(e.target.value)} />
    if (columnId === 'provenance' && csProvenanceOptions.length > 0) return (
      <ColumnFilterSelect value={csFilterProvenance || null} options={csProvenanceOptions} placeholder="..." onChange={(v) => setCsFilterProvenance(v ?? '')} triggerClass={CS_FILTER_TRIGGER} />
    )
    return null
  }

  // TanStack column definitions for concept sets browse
  const csColumns = useMemo<ColumnDef<CsBrowseRow>[]>(() => [
    {
      id: 'category',
      header: () => t('concept_mapping.col_category'),
      accessorFn: (row) => row.category,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.category}</span>,
      size: 80,
      minSize: 50,
    },
    {
      id: 'subcategory',
      header: () => t('concept_mapping.col_subcategory'),
      accessorFn: (row) => row.subcategory,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.subcategory}</span>,
      size: 80,
      minSize: 50,
    },
    {
      id: 'name',
      header: () => t('concept_mapping.col_concept_set'),
      accessorFn: (row) => row.name,
      cell: ({ row }) => row.original.name,
      size: 180,
      minSize: 80,
    },
    {
      id: 'items',
      header: () => t('concept_mapping.cs_col_items'),
      accessorFn: (row) => row.items,
      cell: ({ row }) => (
        <span className="flex justify-center">
          <Badge variant="secondary" className="text-[9px]">{row.original.items}</Badge>
        </span>
      ),
      size: 50,
      minSize: 40,
    },
    {
      id: 'version',
      header: () => t('concept_mapping.cs_col_version'),
      accessorFn: (row) => row.version,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.version}</span>,
      size: 60,
      minSize: 40,
    },
    {
      id: 'provenance',
      header: () => t('concept_mapping.cs_filter_provenance'),
      accessorFn: (row) => row.provenance,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.provenance}</span>,
      size: 80,
      minSize: 50,
    },
    {
      id: '_actions',
      header: '',
      cell: ({ row }) => (
        <button
          type="button"
          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
          title={t('concept_mapping.cs_view_detail')}
          onClick={(e) => {
            e.stopPropagation()
            setDetailSheetCs(row.original.raw)
            setDetailSheetOpen(true)
          }}
        >
          <Info size={12} />
        </button>
      ),
      size: 28,
      minSize: 28,
      enableResizing: false,
    },
  ], [t])

  /** Get human-readable label for a concept set column. */
  const getCsColLabel = (id: string): string => {
    const def = csColumns.find((c) => 'id' in c && c.id === id)
    if (def && typeof def.header === 'function') {
      const result = (def.header as () => unknown)()
      if (typeof result === 'string') return result
    }
    return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }

  const csTable = useReactTable({
    data: csFullPageItems,
    columns: csColumns,
    state: { columnVisibility: csColVisibility, columnSizing: csColSizing },
    onColumnVisibilityChange: setCsColVisibility,
    onColumnSizingChange: setCsColSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualFiltering: true,
    manualSorting: true,
    pageCount: csFullTotalPages,
  })

  const renderConceptSetsBrowse = () => (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table className="w-full" style={{ tableLayout: 'fixed' }}>
          <TableHeader>
            {/* Column titles */}
            <TableRow>
              {csTable.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => {
                  const colId = header.column.id
                  const isMetaCol = colId.startsWith('_')
                  return (
                    <TableHead
                      key={header.id}
                      className="relative select-none overflow-hidden text-[10px]"
                      style={{ width: header.getSize(), maxWidth: header.getSize() }}
                    >
                      {isMetaCol ? null : (
                        <button
                          type="button"
                          className="flex w-full min-w-0 items-center gap-1 overflow-hidden hover:text-foreground"
                          onClick={() => handleCsSort(colId)}
                        >
                          <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </TruncatedHeader>
                          {!csSorting || csSorting.columnId !== colId
                            ? <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
                            : csSorting.desc
                              ? <ArrowDown size={10} className="shrink-0 text-primary" />
                              : <ArrowUp size={10} className="shrink-0 text-primary" />}
                        </button>
                      )}
                      {/* Resize handle */}
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
            {/* Inline filters */}
            <TableRow className="hover:bg-transparent">
              {csTable.getHeaderGroups().map((headerGroup) =>
                headerGroup.headers.map((header) => (
                  <TableHead
                    key={`filter-${header.id}`}
                    className="px-1 py-1"
                    style={{ width: header.getSize() }}
                  >
                    {renderCsFilter(header.column.id)}
                  </TableHead>
                ))
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {csFullPageItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={csTable.getVisibleLeafColumns().length} className="h-40 text-center">
                  {linkedSets.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 px-4">
                      <p className="text-xs text-muted-foreground">{t('concept_mapping.no_concept_sets_hint')}</p>
                      {onGoToConceptSets && (
                        <button
                          type="button"
                          onClick={onGoToConceptSets}
                          className="text-xs text-primary underline-offset-2 hover:underline"
                        >
                          {t('concept_mapping.go_to_concept_sets')}
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('common.no_results')}</p>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              csTable.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.original.id}
                  className="cursor-pointer"
                  onClick={() => handleSelectCs(row.original.raw)}
                >
                  {row.getVisibleCells().map((cell) => {
                    const rendered = flexRender(cell.column.columnDef.cell, cell.getContext())
                    const raw = cell.getValue()
                    const title = raw != null ? String(raw) : undefined
                    return (
                      <TableCell
                        key={cell.id}
                        className="overflow-hidden truncate text-xs px-2 py-1"
                        style={{ maxWidth: cell.column.getSize() }}
                        title={title}
                      >
                        {rendered}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination + column visibility */}
      <div className="flex items-center justify-between border-t px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {csSortedRows.length} concept sets
          </span>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className="h-6 w-6">
                    <Settings2 size={12} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">{t('common.columns')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="w-[180px]">
              <DropdownMenuLabel className="text-xs">{t('concepts.column_visibility', 'Columns')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {csTable.getAllColumns()
                .filter((col) => !col.id.startsWith('_'))
                .map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.id}
                    checked={col.getIsVisible()}
                    onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                    onSelect={(e) => e.preventDefault()}
                    className="text-xs"
                  >
                    {getCsColLabel(col.id)}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={csPage === 0} onClick={() => setCsPage(csPage - 1)}>
            <ChevronLeft size={14} />
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {csPage + 1} / {csFullTotalPages}
          </span>
          <Button variant="ghost" size="icon-sm" disabled={csPage >= csFullTotalPages - 1} onClick={() => setCsPage(csPage + 1)}>
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  )

  // ─── Resolved concepts view ─────────────────────────────────────────

  const renderResolvedConcepts = () => (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header with back button */}
      <div className="border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => setSelectedCs(null)}>
            <ArrowLeft size={14} />
          </Button>
          <div className="min-w-0 flex-1 rounded-md bg-blue-50 dark:bg-blue-950/50 px-2.5 py-1.5">
            <p className="truncate text-xs font-semibold text-blue-900 dark:text-blue-100">{selectedCsTr.name}</p>
            <div className="flex gap-1 mt-0.5">
              {selectedCsTr.category && (
                <Badge variant="outline" className="text-[9px] border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300">{selectedCsTr.category}</Badge>
              )}
              {selectedCsTr.subcategory && (
                <Badge variant="outline" className="text-[9px] border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300">{selectedCsTr.subcategory}</Badge>
              )}
              <Badge variant="secondary" className="text-[9px] bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 border-0">
                {resolvedConcepts.length} {t('concept_mapping.cs_concepts')}
              </Badge>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            title={t('concept_mapping.cs_detail_info')}
            onClick={() => { setDetailSheetCs(selectedCs); setDetailSheetOpen(true) }}
          >
            <Info size={14} />
          </Button>
        </div>
      </div>

      {/* Table header */}
      {(() => {
        const cols = resolvedColVisibility
        const gridParts: string[] = []
        if (cols.vocab) gridParts.push('70px')
        if (cols.id) gridParts.push('60px')
        if (cols.name) gridParts.push('1fr')
        if (cols.code) gridParts.push('60px')
        if (cols.domain) gridParts.push('70px')
        if (cols.class) gridParts.push('70px')
        if (cols.std) gridParts.push('24px')
        gridParts.push('20px')
        const gridTemplate = gridParts.join(' ')
        return (
          <>
            <div className="grid items-center gap-1 border-b bg-muted/30 px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider" style={{ gridTemplateColumns: gridTemplate }}>
              {cols.vocab && <span>{t('concept_mapping.col_vocabulary')}</span>}
              {cols.id && <span>ID</span>}
              {cols.name && <span>{t('concept_mapping.col_name')}</span>}
              {cols.code && <span>{t('concept_mapping.col_concept_code')}</span>}
              {cols.domain && <span>{t('concept_mapping.col_domain')}</span>}
              {cols.class && <span>{t('concept_mapping.col_concept_class')}</span>}
              {cols.std && <span title={t('concept_mapping.col_std')}>Std</span>}
              <span />
            </div>

            {/* Filter row */}
            <div className="grid items-center gap-1 border-b bg-muted/10 px-3 py-1" style={{ gridTemplateColumns: gridTemplate }}>
              {cols.vocab && <ResolvedMultiSelect options={resolvedFilterOptions.vocab} selected={resolvedFilters.vocab} onChange={(v) => setResolvedFilters((f) => ({ ...f, vocab: v }))} />}
              {cols.id && <input className={`${RESOLVED_FILTER_INPUT} font-mono`} placeholder="ID..." value={resolvedFilters.id ?? ''} onChange={(e) => setResolvedFilters((f) => ({ ...f, id: e.target.value || undefined }))} />}
              {cols.name && <input className={RESOLVED_FILTER_INPUT} placeholder="..." value={resolvedFilters.name ?? ''} onChange={(e) => setResolvedFilters((f) => ({ ...f, name: e.target.value || undefined }))} />}
              {cols.code && <input className={`${RESOLVED_FILTER_INPUT} font-mono`} placeholder="Code..." value={resolvedFilters.code ?? ''} onChange={(e) => setResolvedFilters((f) => ({ ...f, code: e.target.value || undefined }))} />}
              {cols.domain && <ResolvedMultiSelect options={resolvedFilterOptions.domain} selected={resolvedFilters.domain} onChange={(v) => setResolvedFilters((f) => ({ ...f, domain: v }))} />}
              {cols.class && <ResolvedMultiSelect options={resolvedFilterOptions.class} selected={resolvedFilters.class} onChange={(v) => setResolvedFilters((f) => ({ ...f, class: v }))} />}
              {cols.std && <ResolvedMultiSelect options={resolvedFilterOptions.std} selected={resolvedFilters.std} onChange={(v) => setResolvedFilters((f) => ({ ...f, std: v }))} />}
              <span />
            </div>

            {/* Table body */}
            <div className="flex-1 overflow-auto">
              {resolvedLoading ? (
                <div className="flex h-32 items-center justify-center">
                  <Loader2 size={20} className="animate-spin text-muted-foreground" />
                </div>
              ) : resolvedError ? (
                <div className="flex h-32 items-center justify-center px-4">
                  <p className="text-xs text-destructive">{resolvedError}</p>
                </div>
              ) : resolvedPageItems.length === 0 ? (
                <div className="flex h-32 items-center justify-center">
                  <p className="text-xs text-muted-foreground">{t('common.no_results')}</p>
                </div>
              ) : (
                resolvedPageItems.map((rc) => {
                  const alreadyMapped = sourceConcept
                    ? existingMappings.some((m) => m.targetConceptId === rc.conceptId)
                    : false
                  const isSelected = selectedTarget?.conceptId === rc.conceptId
                  return (
                    <button
                      key={rc.conceptId}
                      className={`grid w-full items-center gap-1 px-3 py-1.5 text-left text-xs transition-colors border-b border-border/40 ${
                        isSelected ? 'bg-accent' : 'hover:bg-accent/50'
                      } ${alreadyMapped && !isSelected ? 'opacity-50' : ''}`}
                      style={{ gridTemplateColumns: gridTemplate }}
                      onClick={() => {
                        if (sourceConcept) {
                          setSelectedTarget(isSelected ? null : {
                            conceptId: rc.conceptId,
                            conceptName: rc.conceptName,
                            vocabularyId: rc.vocabularyId,
                            domainId: rc.domainId,
                            conceptCode: rc.conceptCode,
                            conceptClassId: rc.conceptClassId,
                            standardConcept: rc.standardConcept ?? undefined,
                          })
                          // Non-suggestion target: fall back to the manual preference.
                          if (!isSelected) setSelectedEquivalence(manualEquivalence)
                        }
                      }}
                    >
                      {cols.vocab && <span className="truncate text-muted-foreground" title={rc.vocabularyId}>{rc.vocabularyId}</span>}
                      {cols.id && <span className="text-muted-foreground">{rc.conceptId}</span>}
                      {cols.name && <span className="truncate" title={rc.conceptName}>{rc.conceptName}</span>}
                      {cols.code && <span className="truncate text-muted-foreground" title={rc.conceptCode}>{rc.conceptCode}</span>}
                      {cols.domain && <span className="truncate text-muted-foreground" title={rc.domainId}>{rc.domainId}</span>}
                      {cols.class && <span className="truncate text-muted-foreground" title={rc.conceptClassId}>{rc.conceptClassId}</span>}
                      {cols.std && <StandardConceptBadge value={rc.standardConcept} />}
                      <span className="flex justify-center">
                        {alreadyMapped && <Check size={12} className="text-green-600" />}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </>
        )
      })()}

      {/* Pagination */}
      <div className="flex items-center justify-between border-t px-3 py-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            {filteredResolved.length} {t('concept_mapping.cs_concepts')}
          </span>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className="h-6 w-6">
                    <Settings2 size={12} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">{t('common.columns')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="w-[180px]">
              <DropdownMenuLabel className="text-xs">{t('concepts.column_visibility', 'Columns')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {([
                ['vocab', t('concept_mapping.col_vocabulary')],
                ['id', t('concept_mapping.col_concept_id')],
                ['name', t('concept_mapping.col_name')],
                ['code', t('concept_mapping.col_concept_code')],
                ['domain', t('concept_mapping.col_domain')],
                ['class', t('concept_mapping.col_concept_class')],
                ['std', t('concept_mapping.col_std')],
              ] as const).map(([col, label]) => (
                <DropdownMenuCheckboxItem
                  key={col}
                  checked={resolvedColVisibility[col]}
                  onCheckedChange={(v) => setResolvedColVisibility((prev) => ({ ...prev, [col]: v }))}
                  onSelect={(e) => e.preventDefault()}
                  className="text-xs"
                >
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={resolvedPage === 0} onClick={() => setResolvedPage(resolvedPage - 1)}>
            <ChevronLeft size={14} />
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {resolvedPage + 1} / {resolvedTotalPages}
          </span>
          <Button variant="ghost" size="icon-sm" disabled={resolvedPage >= resolvedTotalPages - 1} onClick={() => setResolvedPage(resolvedPage + 1)}>
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  )

  // ─── Search mode: TanStack DataTable ─────────────────────────────

  const [searchColVisibility, setSearchColVisibility] = useState<VisibilityState>({ concept_id: false, concept_code: false, valid: false })
  const [searchColSizing, setSearchColSizing] = useState<Record<string, number>>({})
  const [searchSorting, setSearchSorting] = useState<{ columnId: string; desc: boolean } | null>(null)
  const [searchPage, setSearchPage] = useState(0)
  const SEARCH_PAGE_SIZE = 50

  // Inline column filters for search results (client-side post-filtering)
  interface SearchColumnFilters {
    concept_id?: string
    concept_name?: string
    concept_code?: string
    vocabulary_id?: string
    domain_id?: Set<string>
    concept_class_id?: Set<string>
    standard_concept?: string | null
  }
  const [searchColFilters, setSearchColFilters] = useState<SearchColumnFilters>({})

  // Apply inline filters to search results
  const filteredSearchResults = searchResults.filter((r) => {
    const f = searchColFilters
    if (f.concept_id && !String(r.concept_id).includes(f.concept_id)) return false
    if (f.concept_name && !r.concept_name.toLowerCase().includes(f.concept_name.toLowerCase())) return false
    if (f.concept_code && !r.concept_code.toLowerCase().includes(f.concept_code.toLowerCase())) return false
    if (f.vocabulary_id && r.vocabulary_id !== f.vocabulary_id) return false
    if (f.domain_id?.size && !f.domain_id.has(r.domain_id ?? '')) return false
    if (f.concept_class_id?.size && !f.concept_class_id.has(r.concept_class_id ?? '')) return false
    if (f.standard_concept && (r.standard_concept ?? '') !== f.standard_concept) return false
    return true
  })

  const updateSearchFilter = (key: keyof SearchColumnFilters, value: string | null | Set<string>) => {
    setSearchColFilters((prev) => ({
      ...prev,
      [key]: value instanceof Set ? (value.size > 0 ? value : undefined) : (value ?? undefined),
    }))
    setSearchPage(0)
  }

  const SEARCH_FILTER_INPUT_CLASS = 'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

  // Compute distinct values for inline column filters from search results
  const searchResultFilterOptions = useMemo(() => {
    const unique = (fn: (r: SearchResult) => string | undefined) =>
      [...new Set(searchResults.map(fn).filter(Boolean) as string[])].sort()
    return {
      vocabulary_id: unique((r) => r.vocabulary_id),
      domain_id: unique((r) => r.domain_id),
      concept_class_id: unique((r) => r.concept_class_id),
    }
  }, [searchResults])

  const renderSearchColumnFilter = (columnId: string) => {
    if (columnId === 'vocabulary_id' && searchResultFilterOptions.vocabulary_id.length > 0) {
      return <ColumnFilterSelect value={searchColFilters.vocabulary_id ?? null} options={searchResultFilterOptions.vocabulary_id} placeholder="Vocab" onChange={(v) => updateSearchFilter('vocabulary_id', v)} />
    }
    if (columnId === 'concept_id') {
      return <input className={`${SEARCH_FILTER_INPUT_CLASS} font-mono`} placeholder="ID..." value={searchColFilters.concept_id ?? ''} onChange={(e) => updateSearchFilter('concept_id', e.target.value || null)} />
    }
    if (columnId === 'concept_name') {
      return <input className={SEARCH_FILTER_INPUT_CLASS} placeholder="..." value={searchColFilters.concept_name ?? ''} onChange={(e) => updateSearchFilter('concept_name', e.target.value || null)} />
    }
    if (columnId === 'concept_code') {
      return <input className={`${SEARCH_FILTER_INPUT_CLASS} font-mono`} placeholder="Code..." value={searchColFilters.concept_code ?? ''} onChange={(e) => updateSearchFilter('concept_code', e.target.value || null)} />
    }
    if (columnId === 'domain_id' && searchResultFilterOptions.domain_id.length > 0) {
      return <ResolvedMultiSelect options={searchResultFilterOptions.domain_id} selected={searchColFilters.domain_id} onChange={(v) => updateSearchFilter('domain_id', v)} triggerClass={SEARCH_FILTER_INPUT_CLASS} />
    }
    if (columnId === 'concept_class_id' && searchResultFilterOptions.concept_class_id.length > 0) {
      return <ResolvedMultiSelect options={searchResultFilterOptions.concept_class_id} selected={searchColFilters.concept_class_id} onChange={(v) => updateSearchFilter('concept_class_id', v)} triggerClass={SEARCH_FILTER_INPUT_CLASS} />
    }
    if (columnId === 'standard_concept') {
      return (
        <Select value={searchColFilters.standard_concept ?? '__all__'} onValueChange={(v) => updateSearchFilter('standard_concept', v === '__all__' ? null : v)}>
          <SelectTrigger className="h-6 w-full overflow-hidden border-dashed text-[10px] font-normal [&>svg]:hidden">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('concept_mapping.filter_all')}</SelectItem>
            <SelectItem value="S" className="text-xs">S</SelectItem>
            <SelectItem value="C" className="text-xs">C</SelectItem>
          </SelectContent>
        </Select>
      )
    }
    return null
  }

  const searchColumns = useMemo<ColumnDef<SearchResult>[]>(() => [
    {
      id: 'vocabulary_id',
      header: () => t('concept_mapping.col_vocabulary'),
      accessorFn: (row) => row.vocabulary_id,
      cell: ({ row }) => row.original.vocabulary_id,
      size: 80,
      minSize: 50,
    },
    {
      id: 'concept_id',
      header: () => t('concept_mapping.col_concept_id'),
      accessorFn: (row) => row.concept_id,
      cell: ({ row }) => <span className="font-mono">{row.original.concept_id}</span>,
      size: 70,
      minSize: 50,
    },
    {
      id: 'concept_name',
      header: () => t('concept_mapping.col_name'),
      accessorFn: (row) => row.concept_name,
      cell: ({ row }) => row.original.concept_name,
      size: 200,
      minSize: 100,
    },
    {
      id: 'concept_code',
      header: () => t('concept_mapping.col_concept_code'),
      accessorFn: (row) => row.concept_code,
      cell: ({ row }) => <span className="font-mono">{row.original.concept_code}</span>,
      size: 80,
      minSize: 50,
    },
    {
      id: 'domain_id',
      header: () => t('concept_mapping.col_domain'),
      accessorFn: (row) => row.domain_id,
      cell: ({ row }) => row.original.domain_id ?? '',
      size: 80,
      minSize: 50,
    },
    {
      id: 'concept_class_id',
      header: () => t('concept_mapping.col_concept_class'),
      accessorFn: (row) => row.concept_class_id,
      cell: ({ row }) => row.original.concept_class_id ?? '',
      size: 90,
      minSize: 50,
    },
    {
      id: 'standard_concept',
      header: () => t('concept_mapping.col_std'),
      accessorFn: (row) => row.standard_concept,
      cell: ({ row }) => {
        const sc = row.original.standard_concept
        return <StandardConceptBadge value={sc} />
      },
      size: 40,
      minSize: 30,
    },
    {
      id: 'valid',
      header: () => t('concept_mapping.col_valid'),
      accessorFn: (row) => row.invalid_reason ?? '',
      cell: ({ row }) => <ValidityBadge value={row.original.invalid_reason} />,
      size: 40,
      minSize: 30,
    },
    {
      id: '_actions',
      header: '',
      cell: ({ row }) => {
        const alreadyMapped = sourceConcept
          ? existingMappings.some((m) => m.targetConceptId === row.original.concept_id)
          : false
        return (
          <div className="flex items-center justify-end gap-0.5">
            {alreadyMapped && <Check size={11} className="text-green-600 shrink-0" />}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation()
                    const r = row.original
                    setConceptDetailTarget({
                      concept_id: r.concept_id,
                      concept_name: r.concept_name,
                      concept_code: r.concept_code ?? undefined,
                      vocabulary_id: r.vocabulary_id ?? undefined,
                      domain_id: r.domain_id ?? undefined,
                      concept_class_id: r.concept_class_id ?? undefined,
                      standard_concept: r.standard_concept ?? undefined,
                    })
                    setConceptDetailOpen(true)
                  }}
                >
                  <Info size={11} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">{t('concept_mapping.concept_info_btn')}</TooltipContent>
            </Tooltip>
          </div>
        )
      },
      size: 48,
      minSize: 48,
      enableResizing: false,
    },
  ], [t, sourceConcept, existingMappings, setConceptDetailTarget])

  // Apply sorting to filtered search results
  const sortedSearchResults = useMemo(() => {
    if (!searchSorting) return filteredSearchResults
    const { columnId, desc } = searchSorting
    const dir = desc ? -1 : 1
    return [...filteredSearchResults].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[columnId]
      const bv = (b as unknown as Record<string, unknown>)[columnId]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv)
      return dir * String(av).localeCompare(String(bv))
    })
  }, [filteredSearchResults, searchSorting])

  const handleSearchSort = (columnId: string) => {
    if (searchSorting?.columnId === columnId) {
      if (searchSorting.desc) setSearchSorting({ columnId, desc: false })
      else setSearchSorting(null)
    } else {
      setSearchSorting({ columnId, desc: true })
    }
    setSearchPage(0)
  }

  const searchPageItems = sortedSearchResults.slice(searchPage * SEARCH_PAGE_SIZE, (searchPage + 1) * SEARCH_PAGE_SIZE)
  const searchTotalPages = Math.max(1, Math.ceil(sortedSearchResults.length / SEARCH_PAGE_SIZE))

  const searchTable = useReactTable({
    data: searchPageItems,
    columns: searchColumns,
    state: { columnVisibility: searchColVisibility, columnSizing: searchColSizing },
    onColumnVisibilityChange: setSearchColVisibility,
    onColumnSizingChange: setSearchColSizing,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: searchTotalPages,
  })

  /** Get human-readable label for a column. */
  const getSearchColLabel = (id: string): string => {
    const col = searchColumns.find((c) => 'id' in c && c.id === id)
    if (col && typeof col.header === 'function') {
      const result = (col.header as () => string)()
      if (typeof result === 'string') return result
    }
    if (col && typeof col.header === 'string') return col.header
    return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }

  // Disable the search row entirely when no vocabulary reference or data source is
  // available — there's nothing to search against. Mirrors the empty-state hint
  // shown below in the results area.
  const noVocabAvailable = !project.vocabularyDataSourceId && !dataSource

  // ─── Suggestions: from imported scores ───────────────────────────────────
  const { index: scoresIndex, loadProjectMeta, importScores, deleteProjectScores, queryScoresForSource, hasSuggestionsFor } = useSuggestionScoresStore()

  useEffect(() => {
    loadProjectMeta(project.id)
  }, [project.id, loadProjectMeta])

  const [suggestions, setSuggestions] = useState<SuggestionCandidate[]>([])
  // Id of the source concept the current `suggestions` array was resolved for.
  // Null means "no resolved result yet" — we render a loader until the effect catches up.
  const [suggestionsForConceptId, setSuggestionsForConceptId] = useState<number | null>(null)
  useEffect(() => {
    if (!sourceConcept) { setSuggestions([]); setSuggestionsForConceptId(null); return }
    // `terminology` is a legacy field name not modeled on SourceConceptRow
    const vocabId = sourceConcept.vocabulary_id ?? (sourceConcept as { terminology?: string }).terminology ?? ''
    const code = sourceConcept.concept_code ?? ''
    const conceptId = sourceConcept.concept_id
    if (!vocabId || !code) { setSuggestions([]); setSuggestionsForConceptId(conceptId); return }
    // Optimistic empty state: the index knows whether any rows match without hitting DuckDB.
    if (scoresIndex && !hasSuggestionsFor(vocabId, code)) {
      setSuggestions([])
      setSuggestionsForConceptId(conceptId)
      return
    }
    let cancelled = false
    queryScoresForSource(vocabId, code).then((rows) => {
      if (cancelled) return
      if (rows.length === 0) { setSuggestions([]); setSuggestionsForConceptId(conceptId); return }
      const byConceptId = new Map<number, typeof rows>()
      for (const r of rows) {
        const arr = byConceptId.get(r.concept_id) ?? []
        arr.push(r)
        byConceptId.set(r.concept_id, arr)
      }
      const candidates: SuggestionCandidate[] = [...byConceptId.entries()].map(([targetConceptId, conceptRows]) => {
        const scores = conceptRows.map((r) => {
          const provider = getProviderForMethod(r.method)
          return {
            provider,
            method: r.method,
            score: r.score,
            weight: weights[provider] ?? 1,
            equivalence: r.equivalence,
            comment: r.comment,
            createdAt: r.created_at,
            conceptSetUid: r.concept_set_uid,
            conceptSetSourceRepo: r.concept_set_source_repo,
          }
        })
        const conceptSet = pickFirstConceptSet(scores)
        return {
          concept_id: targetConceptId,
          concept_name: '',
          concept_code: '',
          vocabulary_id: '',
          scores,
          combined_score: computeCombinedScore(scores),
          equivalence: pickStrongestEquivalence(scores),
          comment: pickFirstComment(scores),
          conceptSetUid: conceptSet.uid,
          conceptSetSourceRepo: conceptSet.sourceRepo,
        }
      }).sort((a, b) => b.combined_score - a.combined_score)
      setSuggestions(candidates)
      setSuggestionsForConceptId(conceptId)
    }).catch(() => {
      if (cancelled) return
      setSuggestions([])
      setSuggestionsForConceptId(conceptId)
    })
    return () => { cancelled = true }
  }, [project.id, sourceConcept?.concept_id, sourceConcept?.vocabulary_id, sourceConcept?.concept_code, weights, queryScoresForSource, hasSuggestionsFor, scoresIndex])

  const suggestionsLoading = sourceConcept != null && suggestionsForConceptId !== sourceConcept.concept_id

  const [enrichedSuggestions, setEnrichedSuggestions] = useState<SuggestionCandidate[]>([])
  useEffect(() => {
    if (suggestions.length === 0) { setEnrichedSuggestions([]); return }
    const dsId = project.vocabularyDataSourceId ?? dataSource?.id
    const targetMapping = dataSource?.schemaMapping ?? (
      project.vocabularyDataSourceId
        ? allDataSources.find((s) => s.id === project.vocabularyDataSourceId)?.schemaMapping
        : undefined
    )
    if (!dsId || !targetMapping) { setEnrichedSuggestions(suggestions); return }

    const dict = (targetMapping.conceptTables ?? [])[0]
    if (!dict) { setEnrichedSuggestions(suggestions); return }

    const ids = suggestions.map((s) => s.concept_id).join(', ')
    const table = dict.table
    const idCol = dict.idColumn ?? 'concept_id'
    const nameCol = dict.nameColumn ?? 'concept_name'
    const codeCol = dict.codeColumn ?? 'concept_code'
    const vocabCol = dict.terminologyIdColumn ?? dict.vocabularyColumn ?? 'vocabulary_id'
    const domainCol = dict.extraColumns?.domain_id ?? dict.categoryColumn
    const classCol = dict.extraColumns?.concept_class_id ?? dict.subcategoryColumn
    const stdCol = dict.extraColumns?.standard_concept
    const invalidCol = dict.extraColumns?.invalid_reason
    const extraCols = [
      domainCol ? `${domainCol} AS domain_id` : null,
      classCol ? `${classCol} AS concept_class_id` : null,
      stdCol ? `${stdCol} AS standard_concept` : null,
      invalidCol ? `${invalidCol} AS invalid_reason` : null,
    ].filter(Boolean).join(', ')
    const sql = `SELECT ${idCol} AS concept_id, ${nameCol} AS concept_name, ${codeCol} AS concept_code, ${vocabCol} AS vocabulary_id${extraCols ? ', ' + extraCols : ''} FROM ${table} WHERE ${idCol} IN (${ids})`

    ensureMounted(dsId).then(() =>
      queryDataSource(dsId, sql) as Promise<Record<string, unknown>[]>
    ).then((rows) => {
      const byId = new Map(rows.map((r) => [Number(r.concept_id), r]))
      setEnrichedSuggestions(suggestions.map((s) => {
        const info = byId.get(s.concept_id)
        if (!info) return s
        return {
          ...s,
          concept_name: String(info.concept_name ?? ''),
          concept_code: String(info.concept_code ?? ''),
          vocabulary_id: String(info.vocabulary_id ?? ''),
          domain_id: info.domain_id != null ? String(info.domain_id) : undefined,
          concept_class_id: info.concept_class_id != null ? String(info.concept_class_id) : undefined,
          standard_concept: info.standard_concept != null ? String(info.standard_concept) : undefined,
          invalid_reason: info.invalid_reason != null ? String(info.invalid_reason) : null,
        }
      }))
    }).catch(() => setEnrichedSuggestions(suggestions))
  }, [suggestions, project.vocabularyDataSourceId, dataSource, allDataSources, ensureMounted])

  const handleImportScoresFile = useCallback(async (file: File) => {
    setSuggestionsImporting(true)
    setSuggestionsImportError(null)
    try {
      await importScores(project.id, file)
    } catch (err) {
      setSuggestionsImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setSuggestionsImporting(false)
    }
  }, [project.id, importScores])

  const suggestionsAlreadyMappedIds = useMemo(() => new Set(
    mappings
      .filter((m) => m.projectId === project.id && m.sourceConceptId === sourceConcept?.concept_id && m.status !== 'suggested')
      .map((m) => m.targetConceptId),
  ), [mappings, project.id, sourceConcept?.concept_id])

  const totalProjectScores = scoresIndex?.rowCount ?? 0

  const renderSuggestionsPanel = () => {
    if (totalProjectScores === 0) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
          <Sparkles size={20} className="text-muted-foreground/40" />
          <p className="text-[11px] font-medium text-muted-foreground">
            {t('concept_mapping.suggestions_no_scores')}
          </p>
          <p className="text-[10px] text-muted-foreground/70">
            {t('concept_mapping.suggestions_no_scores_hint')}
          </p>
        </div>
      )
    }
    if (!sourceConcept) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
          <Sparkles size={20} className="text-muted-foreground/40" />
          <p className="text-[11px] font-medium text-muted-foreground">
            {t('concept_mapping.suggestions_no_source_concept')}
          </p>
          <p className="text-[10px] text-muted-foreground/70">
            {t('concept_mapping.suggestions_no_source_concept_hint')}
          </p>
        </div>
      )
    }
    if (suggestionsLoading) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
          <Loader2 size={20} className="animate-spin text-muted-foreground/40" />
        </div>
      )
    }
    if (suggestions.length === 0) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
          <Sparkles size={20} className="text-muted-foreground/40" />
          <p className="text-[11px] font-medium text-muted-foreground">
            {t('concept_mapping.suggestions_empty')}
          </p>
          <p className="text-[10px] text-muted-foreground/70">
            {t('concept_mapping.suggestions_empty_hint')}
          </p>
        </div>
      )
    }
    return (
      <SuggestionsTable
        suggestions={enrichedSuggestions}
        weights={weights}
        view={suggestionsView}
        onViewChange={setSuggestionsView}
        alreadyMappedIds={suggestionsAlreadyMappedIds}
        selectedConceptId={selectedTarget?.conceptId ?? null}
        onSelect={(s) => {
          if (!s || !sourceConcept) { setSelectedTarget(null); return }
          setSelectedTarget({
            conceptId: s.concept_id,
            conceptName: s.concept_name,
            vocabularyId: s.vocabulary_id,
            domainId: s.domain_id ?? '',
            conceptCode: s.concept_code,
            conceptClassId: s.concept_class_id,
            standardConcept: s.standard_concept,
          })
          // Preload the add button with the equivalence the suggestion proposes; a
          // subsequent manual pick via the dropdown overrides it until the next select.
          setSelectedEquivalence(normalizeEquivalence(s.equivalence))
        }}
        onInfo={(s) => {
          setConceptDetailTarget({
            concept_id: s.concept_id,
            concept_name: s.concept_name,
            concept_code: s.concept_code,
            vocabulary_id: s.vocabulary_id,
            domain_id: s.domain_id,
            concept_class_id: s.concept_class_id,
            standard_concept: s.standard_concept,
          })
          setConceptDetailOpen(true)
        }}
        conceptSetNamesByUid={conceptSetNamesByUid}
        onConceptSet={(s) => {
          if (!s.conceptSetUid) return
          const cs = conceptSetsByUid.get(s.conceptSetUid)
          if (cs) {
            setDetailSheetCs(cs)
            setDetailSheetOpen(true)
          } else {
            setCsNotLocal({ uid: s.conceptSetUid, sourceRepo: s.conceptSetSourceRepo })
          }
        }}
      />
    )
  }

  const renderSearchMode = () => (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Search bar + filter + search button */}
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        {/* Filter popover */}
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" disabled={noVocabAvailable} className={`h-8 w-8 shrink-0 ${(searchFilterVocabs.size + searchFilterDomains.size + searchFilterClasses.size + searchFilterStandard.size > 0) ? 'text-primary' : ''}`}>
                  <SlidersHorizontal size={14} />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{t('concept_mapping.search_filters')}</TooltipContent>
          </Tooltip>
          <PopoverContent align="start" className="w-[280px] p-3 space-y-3" onCloseAutoFocus={(e) => e.preventDefault()}>
            <p className="text-xs font-medium">{t('concept_mapping.search_filters')}</p>
            {/* Vocabulary */}
            {searchFilterOptions.vocabs.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t('concept_mapping.col_vocabulary')}</label>
                <ResolvedMultiSelect options={searchFilterOptions.vocabs} selected={searchFilterVocabs} onChange={setSearchFilterVocabs} />
              </div>
            )}
            {/* Domain */}
            {searchFilterOptions.domains.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t('concept_mapping.col_domain')}</label>
                <ResolvedMultiSelect options={searchFilterOptions.domains} selected={searchFilterDomains} onChange={setSearchFilterDomains} />
              </div>
            )}
            {/* Concept Class */}
            {searchFilterOptions.classes.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t('concept_mapping.col_concept_class')}</label>
                <ResolvedMultiSelect options={searchFilterOptions.classes} selected={searchFilterClasses} onChange={setSearchFilterClasses} />
              </div>
            )}
            {/* Standard */}
            {searchFilterOptions.standards.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t('concept_mapping.col_std')}</label>
                <div className="flex gap-1">
                  {searchFilterOptions.standards.map((s) => (
                    <Button
                      key={s}
                      size="xs"
                      variant={searchFilterStandard.has(s) ? 'default' : 'outline'}
                      className={`h-6 text-[10px] ${searchFilterStandard.has(s) && s === 'S' ? 'bg-green-600 hover:bg-green-700' : ''}`}
                      onClick={() => {
                        const next = new Set(searchFilterStandard)
                        if (next.has(s)) next.delete(s); else next.add(s)
                        setSearchFilterStandard(next)
                      }}
                    >
                      {s}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {/* Max results */}
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t('concept_mapping.search_max_results')}</label>
              <Input
                type="number"
                className="h-7 text-xs"
                value={searchMaxResults}
                min={1}
                max={100000}
                onChange={(e) => setSearchMaxResults(Math.max(1, parseInt(e.target.value) || 1000))}
              />
              {searchMaxResults > 10000 && (
                <p className="text-[10px] text-destructive">{t('concept_mapping.search_max_results_warning')}</p>
              )}
            </div>
          </PopoverContent>
        </Popover>
        {/* Search input */}
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder={noVocabAvailable ? t('concept_mapping.no_vocab_for_search_short') : t('concept_mapping.search_omop')}
            value={searchTerm}
            disabled={noVocabAvailable}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                // preventDefault: see ConceptSetsTab — without it the warning
                // AlertDialog that handleSearch may open would auto-close because
                // its focused action button receives the bubbled Enter keydown.
                e.preventDefault()
                handleSearch()
              }
            }}
          />
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={handleSearch} disabled={searching || noVocabAvailable}>
          {searching ? <Loader2 size={14} className="animate-spin" /> : t('common.search')}
        </Button>
      </div>

      {/* Results table */}
      <div className="min-h-0 flex-1 overflow-auto" style={{ paddingRight: 'calc(var(--spacing) * 2.5)' }}>
        {searchResults.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 px-4">
            {searching ? (
              <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
            ) : !project.vocabularyDataSourceId && !dataSource ? (
              <>
                <p className="text-center text-xs text-muted-foreground">{t('concept_mapping.no_vocab_for_search_hint')}</p>
                {onGoToConceptSets && (
                  <button
                    type="button"
                    onClick={onGoToConceptSets}
                    className="text-xs text-primary underline-offset-2 hover:underline"
                  >
                    {t('concept_mapping.go_to_concept_sets')}
                  </button>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{t('concept_mapping.search_hint')}</p>
            )}
          </div>
        ) : (
          <Table className="w-full" style={{ tableLayout: 'fixed' }}>
            <TableHeader>
              {/* Column titles */}
              <TableRow>
                {searchTable.getHeaderGroups().map((hg) =>
                  hg.headers.map((header) => {
                    const colId = header.column.id
                    const isSortable = colId !== '_check'
                    const sortIcon = !searchSorting || searchSorting.columnId !== colId
                      ? <ArrowUpDown size={10} className="shrink-0 text-muted-foreground/30" />
                      : searchSorting.desc
                        ? <ArrowDown size={10} className="shrink-0 text-primary" />
                        : <ArrowUp size={10} className="shrink-0 text-primary" />
                    return (
                    <TableHead
                      key={header.id}
                      className="relative select-none overflow-hidden text-xs"
                      style={{ width: header.getSize(), maxWidth: header.getSize() }}
                    >
                      {isSortable ? (
                        <button
                          type="button"
                          className="flex w-full min-w-0 items-center gap-1 overflow-hidden hover:text-foreground"
                          onClick={() => handleSearchSort(colId)}
                        >
                          <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </TruncatedHeader>
                          {sortIcon}
                        </button>
                      ) : (
                        <TruncatedHeader label={headerLabel(header.column.columnDef.header, header.getContext())}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </TruncatedHeader>
                      )}
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
              {/* Inline column filters */}
              <TableRow className="hover:bg-transparent">
                {searchTable.getHeaderGroups().map((hg) =>
                  hg.headers.map((header) => (
                    <TableHead
                      key={`filter-${header.id}`}
                      className="px-1 py-1"
                      style={{ width: header.getSize() }}
                    >
                      {renderSearchColumnFilter(header.column.id)}
                    </TableHead>
                  ))
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {searchTable.getRowModel().rows.map((row) => {
                const alreadyMapped = sourceConcept
                  ? existingMappings.some((m) => m.targetConceptId === row.original.concept_id)
                  : false
                const isSelected = selectedTarget?.conceptId === row.original.concept_id
                return (
                  <TableRow
                    key={row.original.concept_id}
                    className={`cursor-pointer ${isSelected ? 'bg-accent' : ''} ${alreadyMapped && !isSelected ? 'opacity-50' : ''}`}
                    onClick={() => {
                      if (sourceConcept) {
                        setSelectedTarget(isSelected ? null : {
                          conceptId: row.original.concept_id,
                          conceptName: row.original.concept_name,
                          vocabularyId: row.original.vocabulary_id,
                          domainId: row.original.domain_id ?? '',
                          conceptCode: row.original.concept_code,
                          conceptClassId: row.original.concept_class_id,
                          standardConcept: row.original.standard_concept,
                        })
                        // Non-suggestion target: fall back to the manual preference.
                        if (!isSelected) setSelectedEquivalence(manualEquivalence)
                      }
                    }}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const rendered = flexRender(cell.column.columnDef.cell, cell.getContext())
                      const raw = cell.getValue()
                      const title = raw != null ? String(raw) : undefined
                      return (
                        <TableCell
                          key={cell.id}
                          className="overflow-hidden truncate px-2 py-1 text-xs"
                          style={{ maxWidth: cell.column.getSize() }}
                          title={title}
                        >
                          {rendered}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination + column visibility */}
      {searchResults.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t px-3 py-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              {filteredSearchResults.length} / {searchResults.length} {t('common.results').toLowerCase()}
            </span>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" className="h-6 w-6">
                      <Settings2 size={12} />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">{t('common.columns')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" className="w-[180px]">
                <DropdownMenuLabel className="text-xs">{t('concepts.column_visibility', 'Columns')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {searchTable.getAllColumns()
                  .filter((col) => !col.id.startsWith('_'))
                  .map((col) => (
                    <DropdownMenuCheckboxItem
                      key={col.id}
                      checked={col.getIsVisible()}
                      onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                      onSelect={(e) => e.preventDefault()}
                      className="text-xs"
                    >
                      {getSearchColLabel(col.id)}
                    </DropdownMenuCheckboxItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" disabled={searchPage === 0} onClick={() => setSearchPage(searchPage - 1)}>
              <ChevronLeft size={14} />
            </Button>
            <span className="text-[10px] text-muted-foreground">
              {searchPage + 1} / {searchTotalPages}
            </span>
            <Button variant="ghost" size="icon-sm" disabled={searchPage >= searchTotalPages - 1} onClick={() => setSearchPage(searchPage + 1)}>
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </div>
  )

  // ─── Main layout (always show tabs) ──────────────────────────────────

  return (
    <>
    {identityDialog}
    {/* Suggestions settings dialog */}
    <Dialog open={suggestionsSettingsOpen} onOpenChange={setSuggestionsSettingsOpen}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="border-b p-4">
          <DialogTitle className="text-sm font-semibold">{t('concept_mapping.suggestions_manage')}</DialogTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('concept_mapping.suggestions_manage_subtitle')}</p>
        </DialogHeader>
        <div className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('concept_mapping.suggestions_weights_section')}</p>
            {ALL_PROVIDERS.some((p) => weights[p] !== DEFAULT_WEIGHTS[p]) && (
              <button
                type="button"
                className="text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() => setWeights({ ...DEFAULT_WEIGHTS })}
              >
                {t('common.reset')}
              </button>
            )}
          </div>
          <div className="space-y-3">
            {ALL_PROVIDERS.map((provider) => {
              const value = weights[provider] ?? DEFAULT_WEIGHTS[provider] ?? 1
              const dot = METHOD_DOT_COLORS[provider] ?? 'bg-gray-400'
              const label = provider === 'IA' ? 'IA agentique' : provider
              return (
                <div key={provider} className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
                  <div className="flex w-32 items-center gap-2">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
                    <span className="text-xs text-foreground">{label}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={5}
                    step={0.5}
                    value={value}
                    onChange={(e) => setWeights((w) => ({ ...w, [provider]: Number(e.target.value) }))}
                    className="h-1.5 flex-1 accent-foreground"
                  />
                  <span className="w-8 text-right font-mono text-xs tabular-nums text-muted-foreground">×{value.toFixed(1)}</span>
                </div>
              )
            })}
          </div>
          <div className="mt-5 border-t pt-3 text-[11px] text-muted-foreground">
            {totalProjectScores > 0 ? (
              <>
                {t('concept_mapping.suggestions_scores_loaded_from', { formattedCount: totalProjectScores.toLocaleString() })}{' '}
                <code className="font-mono text-foreground">{t('concept_mapping.suggestions_default_filename')}</code>
              </>
            ) : (
              t('concept_mapping.suggestions_no_scores_loaded')
            )}
          </div>
          {suggestionsImportError && (
            <p className="mt-2 text-[11px] text-destructive">{suggestionsImportError}</p>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 rounded-b-lg border-t bg-muted/30 px-4 py-3">
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-3 text-xs"
            disabled={suggestionsImporting}
            onClick={() => suggestionsFileInputRef.current?.click()}
          >
            {suggestionsImporting ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
            {suggestionsImporting ? t('concept_mapping.suggestions_importing') : t('concept_mapping.suggestions_import_file')}
          </Button>
          {totalProjectScores > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-3 text-xs text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:text-rose-400 dark:hover:bg-rose-950/30 dark:hover:text-rose-300"
              onClick={() => setSuggestionsDeleteConfirmOpen(true)}
            >
              <Trash2 size={12} />
              {t('concept_mapping.suggestions_delete_all_btn')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
    <AlertDialog open={suggestionsDeleteConfirmOpen} onOpenChange={setSuggestionsDeleteConfirmOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('concept_mapping.suggestions_delete_confirm_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('concept_mapping.suggestions_delete_confirm_desc', { count: totalProjectScores })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() => {
              deleteProjectScores(project.id)
              setSuggestionsDeleteConfirmOpen(false)
            }}
          >
            {t('common.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={searchWarningOpen} onOpenChange={setSearchWarningOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('concept_mapping.unfiltered_search_warning_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('concept_mapping.unfiltered_search_warning_desc')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={confirmUnfilteredSearch}>{t('concept_mapping.unfiltered_search_warning_proceed')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <div className="flex h-full flex-col overflow-hidden">
      {/* Row 1 — Mode toggle (Jeux de concepts / Recherche / Suggestions) */}
      <div className="flex items-center justify-center border-b px-3 py-1">
        <div className="flex rounded-md bg-muted p-0.5">
          <button
            className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              browseMode === 'search'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => switchBrowseMode('search')}
          >
            {t('concept_mapping.mode_search')}
          </button>
          <button
            className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              browseMode === 'concept_sets'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => switchBrowseMode('concept_sets')}
          >
            {t('concept_mapping.mode_concept_sets')}
          </button>
          <button
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              browseMode === 'suggestions'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => switchBrowseMode('suggestions')}
          >
            <Sparkles size={9} />
            {t('concept_mapping.mode_suggestions')}
          </button>
        </div>
      </div>

      {/* Row 2 — single action bar (suggestions manage btn + mapping buttons) */}
      {(browseMode === 'suggestions' || sourceConcept) && (
        <div className="flex items-center gap-1 border-b px-3 py-1">
          {browseMode === 'suggestions' && (
            <>
              <input
                ref={suggestionsFileInputRef}
                type="file"
                accept=".parquet,.pq,.csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleImportScoresFile(file)
                  e.target.value = ''
                }}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-6 gap-1.5 px-2 text-[10px]"
                onClick={() => setSuggestionsSettingsOpen(true)}
              >
                <SlidersHorizontal size={10} />
                {t('concept_mapping.suggestions_manage')}
                {totalProjectScores > 0 && (
                  <span className="ml-0.5 rounded bg-muted px-1 font-mono text-[9px] tabular-nums text-muted-foreground">
                    {totalProjectScores.toLocaleString()}
                  </span>
                )}
              </Button>
            </>
          )}
          {sourceConcept && (
            <div className="ml-auto flex items-center gap-1">
              {selectedTarget ? (
                selectedTargetMapping ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* Wrapper so the tooltip still fires while the buttons are disabled. */}
                      <div className="flex" ref={equivButtonGroupRef}>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={selectedTargetMappingLocked}
                          className={`h-6 rounded-r-none gap-1 px-2 text-[10px] border-r-0 ${EQUIV_BADGE[normalizeEquivalence(selectedTargetMapping.equivalence)].className}`}
                        >
                          <Check size={10} />
                          {EQUIV_BADGE[normalizeEquivalence(selectedTargetMapping.equivalence)].label}
                        </Button>
                        <DropdownMenu onOpenChange={(open) => { if (open) setEquivDropdownWidth(equivButtonGroupRef.current?.offsetWidth) }}>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className={`h-6 rounded-l-none px-1 ${EQUIV_BADGE[normalizeEquivalence(selectedTargetMapping.equivalence)].className}`} disabled={selectedTargetMappingLocked}>
                              <ChevronDown className="size-2.5 text-current" />
                            </Button>
                          </DropdownMenuTrigger>
                          {/* minWidth, not width: the button's width sizes the badges, but the
                              "remove mapping" label needs room to grow past it. */}
                          <DropdownMenuContent align="end" style={{ minWidth: equivDropdownWidth }} className="min-w-0">
                            <EquivalenceMenuItems onPick={handleChangeSelectedEquivalence} />
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" className="gap-1.5 text-[11px]" onClick={() => handleRemoveSelectedMapping()}>
                              <Trash2 className="size-3" />
                              {t('concept_mapping.remove_mapping')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-xs">
                      {selectedTargetMappingLocked
                        ? t('concept_mapping.mapping_locked_hint')
                        : t('concept_mapping.change_mapping_hint')}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                <>
                  <div className="flex" ref={equivButtonGroupRef}>
                    <Button
                      variant="outline"
                      size="sm"
                      className={`h-6 rounded-r-none gap-1 px-2 text-[10px] border-r-0 ${EQUIV_BADGE[selectedEquivalence].className}`}
                      onClick={() => handleAddSelectedMapping(selectedEquivalence)}
                    >
                      <Plus size={10} />
                      {EQUIV_BADGE[selectedEquivalence].label}
                    </Button>
                    <DropdownMenu onOpenChange={(open) => { if (open) setEquivDropdownWidth(equivButtonGroupRef.current?.offsetWidth) }}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className={`h-6 rounded-l-none px-1 ${EQUIV_BADGE[selectedEquivalence].className}`}>
                          <ChevronDown className="size-2.5 text-current" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" style={{ width: equivDropdownWidth }} className="min-w-0">
                        <EquivalenceMenuItems onPick={pickManualEquivalence} />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 gap-1 px-1.5 text-[10px]"
                    title={t('concept_mapping.map_with_comment')}
                    onClick={() => setCommentDialogOpen(true)}
                  >
                    <MessageSquare size={10} />
                  </Button>
                </>
                )
              ) : (
                <>
                  <Button
                    size="sm"
                    variant={ignoredConceptIds.has(sourceConcept.concept_id) ? 'default' : 'outline'}
                    className={`h-6 gap-1 px-2 text-[10px] ${ignoredConceptIds.has(sourceConcept.concept_id) ? 'bg-gray-500 hover:bg-gray-600' : ''}`}
                    onClick={() => handleToggleIgnored()}
                  >
                    <EyeOff size={10} />
                    {ignoredConceptIds.has(sourceConcept.concept_id)
                      ? t('concept_mapping.unignore')
                      : t('concept_mapping.ignore')}
                  </Button>
                  {!ignoredConceptIds.has(sourceConcept.concept_id) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 gap-1 px-1.5 text-[10px]"
                      title={t('concept_mapping.ignore_with_comment')}
                      onClick={() => setIgnoreDialogOpen(true)}
                    >
                      <MessageSquare size={10} />
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mode content. Rendered off `deferredBrowseMode` so a tab click paints the
          highlight/action bar first; while the transition mounts the (possibly heavy)
          table, show a light skeleton instead of blocking on the mount. */}
      <div className="flex-1 overflow-hidden">
        {tabPending ? (
          <TabSkeleton />
        ) : deferredBrowseMode === 'concept_sets' ? (
          selectedCs ? renderResolvedConcepts() : renderConceptSetsBrowse()
        ) : deferredBrowseMode === 'suggestions' ? (
          renderSuggestionsPanel()
        ) : (
          renderSearchMode()
        )}
      </div>

      {/* "Map with comment" dialog */}
      <Dialog open={commentDialogOpen} onOpenChange={setCommentDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('concept_mapping.map_with_comment')}</DialogTitle>
            <DialogDescription>{t('concept_mapping.map_with_comment_desc')}</DialogDescription>
          </DialogHeader>
          {selectedTarget && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t('concept_mapping.equivalence')}</Label>
                <div>
                  <EquivalencePickerButton value={commentEquivalence} onPick={setCommentEquivalence} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="map-comment">{t('concept_mapping.comment')}</Label>
                <Textarea
                  id="map-comment"
                  rows={3}
                  placeholder={t('concept_mapping.comment_placeholder')}
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommentDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCommentDialogSubmit}>
              {t('concept_mapping.save_mapping')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* "Ignore with comment" dialog */}
      <Dialog open={ignoreDialogOpen} onOpenChange={setIgnoreDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('concept_mapping.ignore_with_comment')}</DialogTitle>
            <DialogDescription>{t('concept_mapping.ignore_with_comment_desc')}</DialogDescription>
          </DialogHeader>
          {sourceConcept && (
            <div className="space-y-2">
              <Label htmlFor="ignore-comment">{t('concept_mapping.comment')}</Label>
              <Textarea
                id="ignore-comment"
                rows={3}
                placeholder={t('concept_mapping.comment_placeholder')}
                value={ignoreCommentText}
                onChange={(e) => setIgnoreCommentText(e.target.value)}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIgnoreDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleIgnoreDialogSubmit}>
              <EyeOff size={14} />
              {t('concept_mapping.ignore')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Concept set detail sheet */}
      <ConceptSetDetailSheet
        conceptSet={detailSheetCs}
        open={detailSheetOpen}
        onOpenChange={setDetailSheetOpen}
        alignContext={sourceConcept ? {
          onAlign: alignResolvedConcept,
          isMapped: (conceptId) => existingMappings.some((m) => m.targetConceptId === conceptId),
        } : undefined}
      />

      {/* Concept set referenced by an AI suggestion but not imported in this workspace */}
      <AlertDialog open={csNotLocal != null} onOpenChange={(o) => { if (!o) setCsNotLocal(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.cs_not_local_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.cs_not_local_desc')}
              {csNotLocal?.sourceRepo && (
                <>
                  {' '}
                  <a
                    href={csNotLocal.sourceRepo}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-2"
                  >
                    {csNotLocal.sourceRepo}
                  </a>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.close')}</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Concept detail sheet (OMOP concept info) */}
      <ConceptDetailSheet
        target={conceptDetailTarget}
        open={conceptDetailOpen}
        onOpenChange={setConceptDetailOpen}
        dataSourceId={vocabDsInfo.dsId}
        conceptTable={vocabDsInfo.conceptTable}
      />
    </div>
    </>
  )
}
