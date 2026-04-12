import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, BarChart3 } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card } from '@/components/ui/card'
import { MarkdownRenderer } from '@/components/editor/MarkdownRenderer'
import type { ConceptSet, ResolvedConcept } from '@/types'
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
const DEFAULT_WIDTH = Math.round(window.innerWidth / 2)

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
        className="p-0"
        style={{ width, maxWidth: width }}
      >
        {/* Resize handle */}
        <div
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />

        <div className="flex h-full flex-col overflow-hidden pl-2">
          <SheetHeader>
            <SheetTitle className="truncate">{csI18n!.name}</SheetTitle>
            <div className="flex flex-wrap gap-1">
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
              <div className="prose prose-sm max-w-none text-xs text-muted-foreground">
                <MarkdownRenderer content={csI18n!.description} />
              </div>
            )}
          </SheetHeader>

          <Tabs defaultValue="description" className="flex flex-1 flex-col overflow-hidden px-4 pb-4">
            <TabsList className="mb-2 w-fit">
              <TabsTrigger value="description">
                {t('concept_mapping.cs_detail_description')}
              </TabsTrigger>
              <TabsTrigger value="statistics">{t('concept_mapping.cs_detail_statistics')}</TabsTrigger>
              <TabsTrigger value="resolved" disabled={!resolvedUrl}>
                {t('concept_mapping.cs_detail_resolved')}
                {resolvedLoaded && resolvedConcepts.length > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-[10px]">{resolvedConcepts.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="expression">{t('concept_mapping.cs_detail_expression')}</TabsTrigger>
            </TabsList>

            <TabsContent value="description" className="flex-1 overflow-hidden">
              {csI18n!.longDescription ? (
                <ScrollArea className="h-full">
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

            <TabsContent value="statistics" className="flex-1 overflow-hidden">
              <ScrollArea className="h-full">
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

            <TabsContent value="resolved" className="flex-1 overflow-hidden">
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
                <ScrollArea className="h-full">
                  <p className="mb-2 text-xs text-muted-foreground">
                    {resolvedConcepts.length} {t('concept_mapping.cs_detail_resolved_count')}
                  </p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('concept_mapping.cs_detail_concept_name')}</TableHead>
                        <TableHead className="w-[70px]">ID</TableHead>
                        <TableHead>{t('concept_mapping.cs_detail_vocabulary')}</TableHead>
                        <TableHead>{t('concept_mapping.cs_detail_domain')}</TableHead>
                        <TableHead>{t('concept_mapping.cs_detail_class')}</TableHead>
                        <TableHead className="w-[30px]">Std</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {resolvedConcepts.map((c) => (
                        <TableRow key={c.conceptId}>
                          <TableCell className="max-w-[200px] truncate text-xs">{c.conceptName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{c.conceptId}</TableCell>
                          <TableCell className="text-xs">{c.vocabularyId}</TableCell>
                          <TableCell className="text-xs">{c.domainId}</TableCell>
                          <TableCell className="text-xs">{c.conceptClassId}</TableCell>
                          <TableCell className="text-center text-xs">{c.standardConcept === 'S' ? <Badge variant="default" className="bg-green-600 px-1 py-0 text-[8px]">S</Badge> : c.standardConcept === 'C' ? <Badge variant="secondary" className="px-1 py-0 text-[8px]">C</Badge> : null}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              )}
            </TabsContent>

            <TabsContent value="expression" className="flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('concept_mapping.cs_detail_concept_name')}</TableHead>
                      <TableHead className="w-[70px]">ID</TableHead>
                      <TableHead>{t('concept_mapping.cs_detail_vocabulary')}</TableHead>
                      <TableHead>{t('concept_mapping.cs_detail_domain')}</TableHead>
                      <TableHead className="w-[30px]" title={t('concept_mapping.cs_detail_excluded')}>Ex</TableHead>
                      <TableHead className="w-[30px]" title={t('concept_mapping.cs_detail_descendants')}>De</TableHead>
                      <TableHead className="w-[30px]" title={t('concept_mapping.cs_detail_mapped')}>Ma</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {conceptSet.expression.items.map((item, i) => {
                      const checkColor = item.isExcluded ? 'text-destructive' : 'text-green-600'
                      return (
                      <TableRow key={i}>
                        <TableCell className="max-w-[200px] truncate text-xs">{item.concept.conceptName}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{item.concept.conceptId}</TableCell>
                        <TableCell className="text-xs">{item.concept.vocabularyId}</TableCell>
                        <TableCell className="text-xs">{item.concept.domainId}</TableCell>
                        <TableCell className={`text-center text-xs ${item.isExcluded ? checkColor : ''}`}>
                          {item.isExcluded ? '✓' : ''}
                        </TableCell>
                        <TableCell className={`text-center text-xs ${item.includeDescendants ? checkColor : ''}`}>{item.includeDescendants ? '✓' : ''}</TableCell>
                        <TableCell className={`text-center text-xs ${item.includeMapped ? checkColor : ''}`}>{item.includeMapped ? '✓' : ''}</TableCell>
                      </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  )
}
