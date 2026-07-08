import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, BarChart3, Check } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StandardConceptBadge } from '@/lib/concept-mapping/standard-concept-badge'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card } from '@/components/ui/card'
import { MarkdownRenderer } from '@/components/editor/MarkdownRenderer'
import type { ConceptSet, ConceptSetItem, ResolvedConcept } from '@/types'
import { getConceptSetI18n } from '@/lib/concept-mapping/i18n'

interface ConceptSetDetailSheetProps {
  conceptSet: ConceptSet | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Derive the resolved concept set URL from the source URL. */
function getResolvedUrl(sourceUrl?: string): string | null {
  if (!sourceUrl) return null
  const match = sourceUrl.match(/\/concept_sets\//)
  if (!match) return null
  return sourceUrl.replace('/concept_sets/', '/concept_sets_resolved/')
}

const MIN_WIDTH = 400
const MAX_WIDTH = 1600
const DEFAULT_WIDTH = Math.round(window.innerWidth * 0.58)

export function ConceptSetDetailSheet({ conceptSet, open, onOpenChange }: ConceptSetDetailSheetProps) {
  const { t, i18n } = useTranslation()
  const csI18n = conceptSet ? getConceptSetI18n(conceptSet, i18n.language) : null

  const [resolvedConcepts, setResolvedConcepts] = useState<ResolvedConcept[]>([])
  const [resolvedLoading, setResolvedLoading] = useState(false)
  const [resolvedError, setResolvedError] = useState<string | null>(null)
  const [resolvedLoaded, setResolvedLoaded] = useState(false)

  // Resizable width
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
    const delta = startX.current - e.clientX
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta)))
  }, [])

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  const resolvedColumns = useMemo<ConceptColumn<ResolvedConcept>[]>(() => [
    { id: 'conceptName', header: t('concept_mapping.cs_detail_concept_name'), accessor: (c) => c.conceptName, filter: 'text', size: 220, minSize: 120 },
    { id: 'conceptId', header: t('concept_mapping.col_concept_id'), accessor: (c) => c.conceptId, filter: 'number', size: 80, minSize: 50, cell: (c) => <span className="font-mono text-xs text-muted-foreground">{c.conceptId}</span> },
    { id: 'vocabularyId', header: t('concept_mapping.cs_detail_vocabulary'), accessor: (c) => c.vocabularyId, filter: 'select', size: 90, minSize: 50 },
    { id: 'domainId', header: t('concept_mapping.cs_detail_domain'), accessor: (c) => c.domainId, filter: 'select', size: 100, minSize: 50 },
    { id: 'conceptClassId', header: t('concept_mapping.cs_detail_class'), accessor: (c) => c.conceptClassId, filter: 'select', size: 100, minSize: 50 },
    { id: 'standardConcept', header: t('concept_mapping.col_std'), accessor: (c) => c.standardConcept ?? '', filter: 'select', size: 70, minSize: 50, center: true, cell: (c) => <StandardConceptBadge value={c.standardConcept} /> },
  ], [t])

  const flagCell = (on: boolean) => on ? <Check size={13} className="mx-auto text-green-600" /> : null
  const expressionColumns = useMemo<ConceptColumn<ConceptSetItem>[]>(() => [
    { id: 'conceptName', header: t('concept_mapping.cs_detail_concept_name'), accessor: (i) => i.concept.conceptName, filter: 'text', size: 220, minSize: 120 },
    { id: 'conceptId', header: t('concept_mapping.col_concept_id'), accessor: (i) => i.concept.conceptId, filter: 'number', size: 80, minSize: 50, cell: (i) => <span className="font-mono text-xs text-muted-foreground">{i.concept.conceptId}</span> },
    { id: 'vocabularyId', header: t('concept_mapping.cs_detail_vocabulary'), accessor: (i) => i.concept.vocabularyId, filter: 'select', size: 90, minSize: 50 },
    { id: 'domainId', header: t('concept_mapping.cs_detail_domain'), accessor: (i) => i.concept.domainId, filter: 'select', size: 100, minSize: 50 },
    { id: 'isExcluded', header: t('concept_mapping.cs_detail_excluded'), accessor: (i) => i.isExcluded ? 1 : 0, filter: 'none', size: 80, minSize: 50, center: true, cell: (i) => flagCell(i.isExcluded) },
    { id: 'includeDescendants', header: t('concept_mapping.cs_detail_descendants'), accessor: (i) => i.includeDescendants ? 1 : 0, filter: 'none', size: 100, minSize: 60, center: true, cell: (i) => flagCell(i.includeDescendants) },
    { id: 'includeMapped', header: t('concept_mapping.cs_detail_mapped'), accessor: (i) => i.includeMapped ? 1 : 0, filter: 'none', size: 80, minSize: 50, center: true, cell: (i) => flagCell(i.includeMapped) },
  ], [t])

  // Reset state when concept set changes
  useEffect(() => {
    setResolvedConcepts([])
    setResolvedLoading(false)
    setResolvedError(null)
    setResolvedLoaded(false)
  }, [conceptSet?.id])

  const handleLoadResolved = useCallback(async () => {
    if (!conceptSet || resolvedLoaded) return
    const url = getResolvedUrl(conceptSet.sourceUrl)
    if (!url) return

    setResolvedLoading(true)
    setResolvedError(null)
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
      setResolvedLoaded(true)
    } catch (err) {
      setResolvedError(err instanceof Error ? err.message : String(err))
    } finally {
      setResolvedLoading(false)
    }
  }, [conceptSet, resolvedLoaded])

  // Auto-load resolved concepts when sheet opens
  useEffect(() => {
    if (open && conceptSet && !resolvedLoaded && getResolvedUrl(conceptSet.sourceUrl)) {
      handleLoadResolved()
    }
  }, [open, conceptSet, resolvedLoaded, handleLoadResolved])

  if (!conceptSet) return null

  const resolvedUrl = getResolvedUrl(conceptSet.sourceUrl)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton
        className="flex flex-col p-0 gap-0"
        style={{ width, maxWidth: MAX_WIDTH, minWidth: MIN_WIDTH }}
      >
        {/* Resize handle */}
        <div
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />

        <SheetHeader className="shrink-0 border-b px-4 py-3">
          <SheetTitle className="text-sm font-semibold leading-tight truncate">{csI18n!.name}</SheetTitle>
          <div className="mt-1 flex flex-wrap gap-1">
            {csI18n!.category && (
              <Badge variant="outline" className="text-[10px]">{csI18n!.category}</Badge>
            )}
            {csI18n!.subcategory && (
              <Badge variant="outline" className="text-[10px]">{csI18n!.subcategory}</Badge>
            )}
            {conceptSet.provenance && (
              <Badge variant="secondary" className="text-[10px]">{conceptSet.provenance}</Badge>
            )}
            <Badge variant="secondary" className="text-[10px]">
              {conceptSet.expression.items.length} {t('concept_mapping.cs_concepts')}
            </Badge>
          </div>
          {csI18n!.description && (
            <div className="prose prose-sm max-w-none text-xs text-muted-foreground mt-1">
              <MarkdownRenderer content={csI18n!.description} />
            </div>
          )}
        </SheetHeader>

        <Tabs defaultValue="description" className="flex flex-col flex-1 min-h-0">
          <TabsList variant="line" className="shrink-0 w-full justify-start rounded-none border-b px-3 mb-0">
            <TabsTrigger value="description" className="text-xs px-3">
              {t('concept_mapping.cs_detail_description')}
            </TabsTrigger>
            <TabsTrigger value="statistics" className="text-xs px-3">
              {t('concept_mapping.cs_detail_statistics')}
            </TabsTrigger>
            <TabsTrigger value="resolved" disabled={!resolvedUrl} className="text-xs px-3">
              {t('concept_mapping.cs_detail_resolved')}
              {resolvedLoaded && resolvedConcepts.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-[10px]">{resolvedConcepts.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="expression" className="text-xs px-3">
              {t('concept_mapping.cs_detail_expression')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="description" className="flex-1 overflow-hidden m-0">
            {csI18n!.longDescription ? (
              <ScrollArea className="h-full px-4 py-3">
                <div className="prose prose-sm max-w-none">
                  <MarkdownRenderer content={csI18n!.longDescription} />
                </div>
              </ScrollArea>
            ) : (
              <div className="flex h-40 items-center justify-center">
                <p className="text-sm text-muted-foreground">{t('concept_mapping.cs_detail_no_description')}</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="statistics" className="flex-1 overflow-hidden m-0">
            <ScrollArea className="h-full px-4 py-3">
              <Card className="flex flex-col items-center justify-center py-12">
                <BarChart3 size={32} className="text-muted-foreground" />
                <p className="mt-3 text-sm text-muted-foreground">
                  {t('concept_mapping.cs_detail_statistics_coming_soon')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  {t('concept_mapping.cs_detail_statistics_coming_soon_desc')}
                </p>
              </Card>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="resolved" className="flex-1 overflow-hidden m-0">
            {!resolvedUrl ? (
              <div className="flex h-40 items-center justify-center">
                <p className="text-sm text-muted-foreground">{t('concept_mapping.cs_detail_resolved_unavailable')}</p>
              </div>
            ) : resolvedLoading ? (
              <div className="flex h-40 items-center justify-center">
                <Loader2 size={20} className="animate-spin text-muted-foreground" />
              </div>
            ) : resolvedError ? (
              <div className="flex h-40 items-center justify-center">
                <p className="text-sm text-destructive">{resolvedError}</p>
              </div>
            ) : resolvedConcepts.length === 0 ? (
              <div className="flex h-40 items-center justify-center">
                <p className="text-sm text-muted-foreground">{t('concept_mapping.cs_detail_resolved_empty')}</p>
              </div>
            ) : (
              <ConceptDataTable
                data={resolvedConcepts}
                rowKey={(c) => c.conceptId}
                columns={resolvedColumns}
              />
            )}
          </TabsContent>

          <TabsContent value="expression" className="flex-1 overflow-hidden m-0">
            <ConceptDataTable
              data={conceptSet.expression.items}
              rowKey={(item) => item.concept.conceptId}
              columns={expressionColumns}
            />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
