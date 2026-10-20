import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Loader2, ArrowLeft, Minimize2 } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TruncatedText } from '@/components/ui/truncated-text'
import { RelationsTable, type RelationRow } from './RelationsTable'
import { queryDataSource } from '@/lib/duckdb/engine'
import { RESIZE_HANDLE_CLASS } from '@/hooks/use-resizable-sidebar'
import {
  buildConceptRelationsQuery,
  buildConceptAncestorsQuery,
  buildConceptDescendantsQuery,
  buildConceptEdgesQuery,
  buildConceptSelfQuery,
  buildConceptSynonymsQuery,
  buildConceptAncestorCountQuery,
  buildConceptDescendantCountQuery,
} from '@/lib/concept-mapping/concept-detail-queries'
import { HierarchyGraph, HIERARCHY_WARN_THRESHOLD, type HierarchyConcept } from './ConceptHierarchyGraph'

const MIN_WIDTH = 400
const MAX_WIDTH = 1600
const DEFAULT_WIDTH = Math.round(window.innerWidth * 0.45)

export interface ConceptInfoTarget {
  concept_id: number
  concept_name: string
  concept_code?: string
  vocabulary_id?: string
  domain_id?: string
  concept_class_id?: string
  standard_concept?: string
  invalid_reason?: string
}

interface ConceptDetailSheetProps {
  target: ConceptInfoTarget | null
  open: boolean
  onOpenChange: (open: boolean) => void
  dataSourceId: string | undefined
  conceptTable: string
}

// ---------------------------------------------------------------------------
// Detail row
// ---------------------------------------------------------------------------

/** The empty second half of a line holding a single field (two-column layout only). */
function DetailCell() {
  return <div className="hidden @lg:block" />
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b py-1.5">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      {typeof children === 'string'
        ? <TruncatedText text={children} className="text-right text-xs font-medium" />
        : <span className="min-w-0 text-right text-xs font-medium">{children}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ConceptDetailSheet({ target, open, onOpenChange, dataSourceId, conceptTable }: ConceptDetailSheetProps) {
  const { t } = useTranslation()

  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(DEFAULT_WIDTH)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [width])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + (startX.current - e.clientX))))
  }, [])
  const onPointerUp = useCallback(() => { dragging.current = false }, [])

  type SynonymRow = { concept_synonym_name: string; language_name?: string }
  type SelfRow = { concept_id: number; concept_name: string; vocabulary_id: string; domain_id?: string; concept_class_id?: string; concept_code?: string; standard_concept: string | null }

  const [relations, setRelations] = useState<RelationRow[]>([])
  const [synonyms, setSynonyms] = useState<SynonymRow[]>([])
  const [hierarchySelf, setHierarchySelf] = useState<SelfRow | null>(null)
  const [hierarchyAncestors, setHierarchyAncestors] = useState<HierarchyConcept[]>([])
  const [hierarchyDescendants, setHierarchyDescendants] = useState<HierarchyConcept[]>([])
  const [hierarchyEdges, setHierarchyEdges] = useState<{ from_id: number; to_id: number }[]>([])
  const [loadingRelations, setLoadingRelations] = useState(false)
  const [loadingHierarchy, setLoadingHierarchy] = useState(false)
  const [loadingSynonyms, setLoadingSynonyms] = useState(false)
  const [relationsUnavailable, setRelationsUnavailable] = useState(false)
  const [hierarchyUnavailable, setHierarchyUnavailable] = useState(false)
  const [synonymsUnavailable, setSynonymsUnavailable] = useState(false)
  const [activeTab, setActiveTab] = useState('details')

  const [hierarchyFullscreen, setHierarchyFullscreen] = useState(false)

  // Navigation stack: [{id, name}, ...], current = last
  const [hierarchyStack, setHierarchyStack] = useState<{ id: number; name: string }[]>([])
  // Pending navigation: held until load is confirmed (not blocked by warn)
  const pendingNavRef = useRef<{ id: number; name: string } | null>(null)
  const currentHierarchyId = hierarchyStack.length > 0 ? hierarchyStack[hierarchyStack.length - 1].id : target?.concept_id
  const currentHierarchyName = hierarchyStack.length > 0 ? hierarchyStack[hierarchyStack.length - 1].name : target?.concept_name

  // Large hierarchy warning
  const [hierarchyWarn, setHierarchyWarn] = useState<{ conceptId: number; total: number } | null>(null)

  // Reset on concept change
  useEffect(() => {
    setRelations([])
    setSynonyms([])
    setHierarchySelf(null)
    setHierarchyAncestors([])
    setHierarchyDescendants([])
    setHierarchyEdges([])
    setRelationsUnavailable(false)
    setHierarchyUnavailable(false)
    setSynonymsUnavailable(false)
    // Keep the user's current tab across concepts (don't force back to details) —
    // the per-tab reload effects below refetch the data for the new concept.
    setHierarchyStack([])
    setHierarchyWarn(null)
  }, [target?.concept_id])

  const doLoadHierarchyForId = useCallback(async (conceptId: number) => {
    if (!dataSourceId) return
    setLoadingHierarchy(true)
    setHierarchySelf(null)
    setHierarchyAncestors([])
    setHierarchyDescendants([])
    setHierarchyEdges([])
    setHierarchyWarn(null)
    setHierarchyUnavailable(false)
    try {
      const [selfRows, ancestorRows, descendantRows] = await Promise.all([
        queryDataSource(dataSourceId, buildConceptSelfQuery(conceptId, conceptTable)) as Promise<SelfRow[]>,
        queryDataSource(dataSourceId, buildConceptAncestorsQuery(conceptId, conceptTable)) as Promise<HierarchyConcept[]>,
        queryDataSource(dataSourceId, buildConceptDescendantsQuery(conceptId, conceptTable)) as Promise<HierarchyConcept[]>,
      ])

      const selfData = selfRows[0]
      if (!selfData) { setHierarchyUnavailable(true); return }

      const allIds = [
        conceptId,
        ...ancestorRows.map((a) => a.concept_id),
        ...descendantRows.map((d) => d.concept_id),
      ]

      const edgeRows = allIds.length > 1
        ? await queryDataSource(dataSourceId, buildConceptEdgesQuery(allIds)) as { from_id: number; to_id: number }[]
        : []

      setHierarchySelf({ ...selfData, hierarchy_level: 0 } as SelfRow)
      setHierarchyAncestors(ancestorRows)
      setHierarchyDescendants(descendantRows)
      setHierarchyEdges(edgeRows)
    } catch {
      setHierarchyUnavailable(true)
    } finally {
      setLoadingHierarchy(false)
    }
  }, [dataSourceId, conceptTable])

  const loadHierarchyForId = useCallback(async (conceptId: number, nav?: { id: number; name: string }) => {
    if (!dataSourceId) return
    try {
      const [ancRows, descRows] = await Promise.all([
        queryDataSource(dataSourceId, buildConceptAncestorCountQuery(conceptId, conceptTable)) as Promise<{ cnt: number }[]>,
        queryDataSource(dataSourceId, buildConceptDescendantCountQuery(conceptId, conceptTable)) as Promise<{ cnt: number }[]>,
      ])
      const total = Number(ancRows[0]?.cnt ?? 0) + Number(descRows[0]?.cnt ?? 0) + 1
      if (total > HIERARCHY_WARN_THRESHOLD) {
        pendingNavRef.current = nav ?? null
        setHierarchyWarn({ conceptId, total })
        return
      }
    } catch {
      // if count fails, proceed anyway
    }
    if (nav) setHierarchyStack((s) => [...s, nav])
    doLoadHierarchyForId(conceptId)
  }, [dataSourceId, conceptTable, doLoadHierarchyForId])

  // Load hierarchy when tab becomes active (no data yet) or stack navigates
  const loadHierarchyForIdRef = useRef(loadHierarchyForId)
  useEffect(() => { loadHierarchyForIdRef.current = loadHierarchyForId }, [loadHierarchyForId])

  useEffect(() => {
    if (activeTab !== 'hierarchy' || !target) return
    if (hierarchySelf) return
    loadHierarchyForIdRef.current(target.concept_id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, target?.concept_id])

  const loadRelations = useCallback(async () => {
    if (!dataSourceId || !target) return
    setLoadingRelations(true)
    try {
      const rows = await queryDataSource(dataSourceId, buildConceptRelationsQuery(target.concept_id, conceptTable)) as unknown as RelationRow[]
      setRelations(rows)
    } catch {
      setRelationsUnavailable(true)
    } finally {
      setLoadingRelations(false)
    }
  }, [dataSourceId, target, conceptTable])

  const loadSynonyms = useCallback(async () => {
    if (!dataSourceId || !target) return
    setLoadingSynonyms(true)
    try {
      const rows = await queryDataSource(dataSourceId, buildConceptSynonymsQuery(target.concept_id)) as SynonymRow[]
      setSynonyms(rows)
    } catch (err) {
      // concept_synonym table may not exist — treat as unavailable, not an error
      setSynonymsUnavailable(true)
      if (err instanceof Error && !err.message.includes('concept_synonym')) {
        console.error(err)
      }
    } finally {
      setLoadingSynonyms(false)
    }
  }, [dataSourceId, target])

  // Relations/synonyms are lazy (loaded on tab click), so when the concept changes
  // while one of those tabs stays active, refetch for the new concept — otherwise
  // the tab would show the just-cleared (empty) data. Mirrors the hierarchy effect.
  // Go through refs and refetch unconditionally: the reset effect above has already
  // cleared the previous concept's rows, but that state clear isn't visible in this
  // effect's closure on the same commit, so a `relations.length === 0` guard would
  // read the STALE (previous, non-empty) array and wrongly skip the reload.
  const loadRelationsRef = useRef(loadRelations)
  const loadSynonymsRef = useRef(loadSynonyms)
  useEffect(() => { loadRelationsRef.current = loadRelations }, [loadRelations])
  useEffect(() => { loadSynonymsRef.current = loadSynonyms }, [loadSynonyms])
  useEffect(() => {
    if (!target) return
    if (activeTab === 'relations') loadRelationsRef.current()
    if (activeTab === 'synonyms') loadSynonymsRef.current()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, target?.concept_id])

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab)
    if (tab === 'relations' && relations.length === 0 && !relationsUnavailable) loadRelations()
    if (tab === 'synonyms' && synonyms.length === 0 && !synonymsUnavailable) loadSynonyms()
    // hierarchy handled by useEffect above
  }, [relations.length, relationsUnavailable, synonyms.length, synonymsUnavailable, loadRelations, loadSynonyms])

  // Stable across renders: the graph rebuilds (and loses its zoom) whenever
  // `self` changes identity, which a resize of the sheet re-rendered every frame.
  const hierarchySelfConcept = useMemo<HierarchyConcept | null>(
    () => (hierarchySelf ? { ...hierarchySelf, hierarchy_level: 0 } : null),
    [hierarchySelf],
  )

  if (!target) return null

  const isStandard = target.standard_concept === 'S'
  const isClassification = target.standard_concept === 'C'
  const isValid = !target.invalid_reason

  const hierarchyEmpty = !loadingHierarchy && !hierarchyUnavailable && !hierarchySelf && !hierarchyWarn
  // While the hierarchy tab is active but the first load hasn't kicked in yet,
  // show the spinner instead of "no hierarchy" — the effect below will set
  // loadingHierarchy=true on the next tick.
  const hierarchyPendingFirstLoad = activeTab === 'hierarchy' && !loadingHierarchy && !hierarchySelf && !hierarchyUnavailable && !hierarchyWarn

  // originId for graph coloring: the concept we navigated from
  const originId = hierarchyStack.length >= 2
    ? hierarchyStack[hierarchyStack.length - 2].id
    : hierarchyStack.length === 1
    ? target.concept_id
    : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton
        style={{ width, maxWidth: MAX_WIDTH, minWidth: MIN_WIDTH }}
        className="flex flex-col p-0 gap-0"
      >
        <div
          className={RESIZE_HANDLE_CLASS}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        />

        <SheetHeader className="shrink-0 border-b px-4 py-3">
          <SheetTitle className="leading-tight">{target.concept_name}</SheetTitle>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs text-muted-foreground">#{target.concept_id}</span>
            {target.vocabulary_id && <Badge className="border-transparent bg-foreground text-background">{target.vocabulary_id}</Badge>}
            {isStandard && <Badge variant="default" className="bg-green-600">{t('concept_mapping.concept_info_standard')}</Badge>}
            {isClassification && <Badge variant="secondary" >{t('concept_mapping.concept_info_classification')}</Badge>}
            {!isStandard && !isClassification && <Badge variant="outline" className="text-destructive border-destructive">{t('concept_mapping.concept_info_non_standard')}</Badge>}
          </div>
        </SheetHeader>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col flex-1 min-h-0">
          <TabsList variant="line" className="shrink-0 w-full justify-start rounded-none border-b px-3 mb-0">
            {(['details', 'relations', 'hierarchy', 'synonyms'] as const).map((tab) => (
              <TabsTrigger key={tab} value={tab} className="text-xs px-3">
                {t(`concept_mapping.concept_info_tab_${tab}`)}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Details */}
          <TabsContent value="details" className="flex-1 overflow-auto m-0">
            <ScrollArea className="h-full">
              {/* One line per pair of fields, two columns; a narrowed sheet falls
                  back to one. A field alone on its line keeps the first column only,
                  so its value sits next to its label rather than at the far edge.
                  A container query, since the sheet is resized independently of
                  the viewport. */}
              <div className="@container px-4 py-3">
                <div className="grid grid-cols-1 gap-x-6 @lg:grid-cols-2">
                  <DetailRow label={t('concept_mapping.col_vocabulary')}>{target.vocabulary_id ?? '—'}</DetailRow>
                  <DetailCell />
                  <DetailRow label={t('concept_mapping.col_concept_id')}>
                    <span className="font-mono">{target.concept_id}</span>
                  </DetailRow>
                  <DetailRow label={t('concept_mapping.col_concept_code')}>
                    <span className="font-mono">{target.concept_code ?? '—'}</span>
                  </DetailRow>
                  <DetailRow label={t('concept_mapping.col_concept_name')}>{target.concept_name}</DetailRow>
                  <DetailCell />
                  <DetailRow label={t('concept_mapping.col_domain')}>{target.domain_id ?? '—'}</DetailRow>
                  <DetailRow label={t('concept_mapping.col_concept_class')}>{target.concept_class_id ?? '—'}</DetailRow>
                  <DetailRow label={t('concept_mapping.concept_info_validity')}>
                    {isValid
                      ? <Badge variant="default" className="bg-green-600 px-1.5 py-0">{t('concept_mapping.concept_info_valid')}</Badge>
                      : <Badge variant="outline" className="px-1.5 py-0 text-destructive border-destructive">{target.invalid_reason ?? t('concept_mapping.concept_info_invalid')}</Badge>}
                  </DetailRow>
                  <DetailRow label={t('concept_mapping.col_std')}>
                    {isStandard
                      ? <Badge variant="default" className="bg-green-600 px-1.5 py-0">{t('concept_mapping.concept_info_standard')}</Badge>
                      : isClassification
                      ? <Badge variant="secondary" className="px-1.5 py-0">{t('concept_mapping.concept_info_classification')}</Badge>
                      : <Badge variant="outline" className="px-1.5 py-0 text-destructive border-destructive">{t('concept_mapping.concept_info_non_standard')}</Badge>}
                  </DetailRow>
                </div>
                <div className="pt-3">
                  <a href={`https://athena.ohdsi.org/search-terms/terms/${target.concept_id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <ExternalLink size={11} />{t('concept_mapping.concept_info_athena')}
                  </a>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Relations */}
          <TabsContent value="relations" className="flex-1 overflow-hidden m-0 flex flex-col min-h-0">
            {loadingRelations ? (
              <div className="flex h-20 items-center justify-center"><Loader2 size={16} className="animate-spin text-muted-foreground" /></div>
            ) : relationsUnavailable ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('concept_mapping.concept_info_table_unavailable')}</p>
            ) : (
              <RelationsTable relations={relations} />
            )}
          </TabsContent>

          {/* Hierarchy */}
          <TabsContent value="hierarchy" className="flex-1 m-0 min-h-0 flex flex-col">
            <div className={hierarchyFullscreen ? 'fixed inset-0 z-[9998] bg-background flex flex-col' : 'flex flex-col flex-1 min-h-0'}>
              <div className="shrink-0 flex items-center gap-2 border-b px-3 py-1.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6"
                  disabled={hierarchyStack.length === 0}
                  onClick={() => {
                    const newStack = hierarchyStack.slice(0, -1)
                    setHierarchyStack(newStack)
                    const prevId = newStack.length > 0 ? newStack[newStack.length - 1].id : target.concept_id
                    doLoadHierarchyForId(prevId)
                  }}
                >
                  <ArrowLeft size={13} />
                </Button>
                <span className="truncate text-[11px] text-muted-foreground flex-1">
                  {currentHierarchyName ?? target.concept_name}
                </span>
                {hierarchyStack.length > 0 && (
                  <span className="text-[10px] text-muted-foreground/50 shrink-0">#{currentHierarchyId}</span>
                )}
                {hierarchyFullscreen && (
                  <button
                    type="button"
                    onClick={() => setHierarchyFullscreen(false)}
                    className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    title={t('common.close')}
                  >
                    <Minimize2 size={13} />
                  </button>
                )}
              </div>
              <div className="flex-1 min-h-0 relative">
                {loadingHierarchy || hierarchyPendingFirstLoad ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 size={16} className="animate-spin text-muted-foreground" />
                  </div>
                ) : hierarchyUnavailable ? (
                  <p className="flex h-full items-center justify-center text-xs text-muted-foreground">{t('concept_mapping.concept_info_table_unavailable')}</p>
                ) : hierarchyWarn ? (
                  <div className="flex h-full items-center justify-center">
                    <div className="flex flex-col items-center gap-3 rounded-lg border bg-card px-6 py-5 text-center shadow-sm max-w-[280px]">
                      <p className="text-sm font-medium">{t('concept_mapping.concept_info_hierarchy_large', { count: hierarchyWarn.total })}</p>
                      <p className="text-xs text-muted-foreground">{t('concept_mapping.concept_info_hierarchy_large_desc')}</p>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm-tight" onClick={() => { pendingNavRef.current = null; setHierarchyWarn(null) }}>
                          {t('common.cancel')}
                        </Button>
                        <Button size="sm-tight" onClick={() => {
                          const nav = pendingNavRef.current
                          pendingNavRef.current = null
                          if (nav) setHierarchyStack((s) => [...s, nav])
                          doLoadHierarchyForId(hierarchyWarn!.conceptId)
                        }}>
                          {t('concept_mapping.concept_info_hierarchy_load_anyway')}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : hierarchyEmpty ? (
                  <p className="flex h-full items-center justify-center text-xs text-muted-foreground">{t('concept_mapping.concept_info_no_hierarchy')}</p>
                ) : hierarchySelfConcept ? (
                  <HierarchyGraph
                    self={hierarchySelfConcept}
                    ancestors={hierarchyAncestors}
                    descendants={hierarchyDescendants}
                    edgeRows={hierarchyEdges}
                    originId={originId}
                    onNavigate={(id, name) => loadHierarchyForId(id, { id, name })}
                    fullscreen={hierarchyFullscreen}
                    onFullscreenChange={setHierarchyFullscreen}
                  />
                ) : null}
              </div>
            </div>
          </TabsContent>

          {/* Synonyms */}
          <TabsContent value="synonyms" className="flex-1 overflow-hidden m-0">
            <ScrollArea className="h-full">
              {loadingSynonyms ? (
                <div className="flex h-20 items-center justify-center"><Loader2 size={16} className="animate-spin text-muted-foreground" /></div>
              ) : synonymsUnavailable ? (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('concept_mapping.concept_info_table_unavailable')}</p>
              ) : synonyms.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('concept_mapping.concept_info_no_synonyms')}</p>
              ) : (
                <ul className="divide-y px-4 py-2">
                  {synonyms.map((s, i) => (
                    <li key={i} className="py-1.5">
                      <p className="text-xs">{s.concept_synonym_name}</p>
                      {s.language_name && <p className="text-[10px] text-muted-foreground">{s.language_name}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
