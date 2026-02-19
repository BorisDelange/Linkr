import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Plus, Check, Flag, X, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildStandardConceptSearchQuery } from '@/lib/concept-mapping/mapping-queries'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { MappingStatusBadge } from './MappingStatusBadge'
import type { MappingProject, DataSource, MappingType, MappingEquivalence } from '@/types'
import type { SourceConceptRow } from '../MappingEditorTab'

interface TargetConceptPanelProps {
  project: MappingProject
  dataSource?: DataSource
  sourceConcept: SourceConceptRow | null
}

interface SearchResult {
  concept_id: number
  concept_name: string
  concept_code: string
  vocabulary_id: string
  domain_id?: string
}

type BrowseMode = 'concept_set' | 'vocabulary'

export function TargetConceptPanel({ project, dataSource, sourceConcept }: TargetConceptPanelProps) {
  const { t } = useTranslation()
  const { mappings, conceptSets, createMapping, updateMapping, deleteMapping } = useConceptMappingStore()

  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [addingTarget, setAddingTarget] = useState<SearchResult | null>(null)
  const [mappingType, setMappingType] = useState<MappingType>('maps_to')
  const [equivalence, setEquivalence] = useState<MappingEquivalence>('equivalent')
  const [comment, setComment] = useState('')

  // Browse mode (when no source concept selected)
  const [browseMode, setBrowseMode] = useState<BrowseMode>('concept_set')
  const [selectedConceptSetId, setSelectedConceptSetId] = useState<string>('__none__')
  const [browseSearch, setBrowseSearch] = useState('')

  // Linked concept sets
  const linkedSets = conceptSets.filter((cs) => project.conceptSetIds.includes(cs.id))

  // Existing mappings for selected source concept
  const existingMappings = sourceConcept
    ? mappings.filter((m) => m.sourceConceptId === sourceConcept.concept_id)
    : []

  const handleSearch = useCallback(async () => {
    if (!searchTerm.trim() || !dataSource?.schemaMapping) return
    setSearching(true)
    try {
      const targetDsId = project.vocabularyDataSourceId ?? dataSource.id
      const sql = buildStandardConceptSearchQuery(
        targetDsId, dataSource.schemaMapping, searchTerm.trim(),
      )
      if (!sql) { setSearching(false); return }
      const results = await queryDataSource(targetDsId, sql)
      setSearchResults(results as unknown as SearchResult[])
    } catch (err) {
      console.error('Search failed:', err)
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [searchTerm, dataSource, project.vocabularyDataSourceId])

  const handleAddMapping = async () => {
    if (!addingTarget || !sourceConcept) return
    const now = new Date().toISOString()
    await createMapping({
      id: crypto.randomUUID(),
      projectId: project.id,
      sourceConceptId: sourceConcept.concept_id,
      sourceConceptName: sourceConcept.concept_name,
      sourceVocabularyId: sourceConcept.vocabulary_id,
      sourceDomainId: sourceConcept.domain_id ?? '',
      sourceConceptCode: sourceConcept.concept_code,
      sourceFrequency: sourceConcept.record_count,
      targetConceptId: addingTarget.concept_id,
      targetConceptName: addingTarget.concept_name,
      targetVocabularyId: addingTarget.vocabulary_id,
      targetDomainId: addingTarget.domain_id ?? '',
      targetConceptCode: addingTarget.concept_code,
      mappingType,
      equivalence,
      status: 'unchecked',
      comment,
      createdAt: now,
      updatedAt: now,
    })
    setAddingTarget(null)
    setComment('')
    setSearchTerm('')
    setSearchResults([])
  }

  // Browse concept set items with fuzzy search
  const getBrowseItems = (): { concept_id: number; concept_name: string; vocabulary_id: string; domain_id: string }[] => {
    if (browseMode !== 'concept_set' || selectedConceptSetId === '__none__') return []
    const cs = linkedSets.find((s) => s.id === selectedConceptSetId)
    if (!cs) return []

    const items = cs.expression.items.map((item) => ({
      concept_id: item.concept.conceptId,
      concept_name: item.concept.conceptName,
      vocabulary_id: item.concept.vocabularyId,
      domain_id: item.concept.domainId,
    }))

    if (!browseSearch.trim()) return items
    const q = browseSearch.toLowerCase()
    return items.filter((item) =>
      item.concept_name.toLowerCase().includes(q) ||
      String(item.concept_id).includes(q) ||
      item.vocabulary_id.toLowerCase().includes(q),
    )
  }

  // When no source concept is selected, show browse panel
  if (!sourceConcept) {
    const browseItems = getBrowseItems()

    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="border-b px-4 py-3">
          <p className="text-xs text-muted-foreground">{t('concept_mapping.browse_target_hint')}</p>
          <div className="mt-2">
            <Select value={browseMode} onValueChange={(v) => setBrowseMode(v as BrowseMode)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="concept_set">{t('concept_mapping.browse_by_concept_set')}</SelectItem>
                <SelectItem value="vocabulary" disabled={!project.vocabularyDataSourceId}>
                  {t('concept_mapping.browse_by_vocabulary')}
                  {!project.vocabularyDataSourceId && (
                    <span className="ml-1 text-muted-foreground">({t('common.coming_soon')})</span>
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {browseMode === 'concept_set' && (
            <div className="mt-2">
              <Select value={selectedConceptSetId} onValueChange={setSelectedConceptSetId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder={t('concept_mapping.browse_select_cs')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('concept_mapping.browse_select_cs')}</SelectItem>
                  {linkedSets.map((cs) => (
                    <SelectItem key={cs.id} value={cs.id}>
                      {cs.name} ({cs.expression.items.length})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {browseMode === 'concept_set' && selectedConceptSetId !== '__none__' && (
            <div className="relative mt-2">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 pl-8 text-xs"
                placeholder={t('concept_mapping.browse_search_cs')}
                value={browseSearch}
                onChange={(e) => setBrowseSearch(e.target.value)}
              />
            </div>
          )}
        </div>

        <ScrollArea className="flex-1">
          {browseMode === 'concept_set' && selectedConceptSetId === '__none__' ? (
            <div className="flex h-32 items-center justify-center">
              <p className="text-xs text-muted-foreground">{t('concept_mapping.browse_pick_cs')}</p>
            </div>
          ) : browseItems.length === 0 ? (
            <div className="flex h-32 items-center justify-center">
              <p className="text-xs text-muted-foreground">{t('common.no_results')}</p>
            </div>
          ) : (
            <div>
              <p className="px-3 py-1.5 text-[10px] text-muted-foreground">
                {browseItems.length} {t('concept_mapping.cs_concepts')}
              </p>
              {browseItems.map((item) => (
                <div
                  key={item.concept_id}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-accent/50"
                >
                  <div className="min-w-0 flex-1">
                    <span className="text-muted-foreground">{item.concept_id}</span>{' '}
                    <span>{item.concept_name}</span>
                  </div>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{item.vocabulary_id}</span>
                  {item.domain_id && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">{item.domain_id}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Source concept info */}
      <div className="border-b bg-muted/30 px-4 py-3">
        <p className="text-xs text-muted-foreground">{t('concept_mapping.source_concept')}</p>
        <p className="mt-0.5 text-sm font-medium">{sourceConcept.concept_name}</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Badge variant="outline" className="text-[10px]">ID: {sourceConcept.concept_id}</Badge>
          <Badge variant="outline" className="text-[10px]">{sourceConcept.vocabulary_id}</Badge>
          {sourceConcept.domain_id && (
            <Badge variant="outline" className="text-[10px]">{sourceConcept.domain_id}</Badge>
          )}
          <Badge variant="outline" className="text-[10px]">
            {sourceConcept.record_count?.toLocaleString()} records
          </Badge>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Existing mappings */}
        {existingMappings.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t('concept_mapping.existing_mappings')} ({existingMappings.length})
            </p>
            <div className="space-y-2">
              {existingMappings.map((m) => (
                <Card key={m.id} className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium">{m.targetConceptName}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="outline" className="text-[10px]">ID: {m.targetConceptId}</Badge>
                        <Badge variant="outline" className="text-[10px]">{m.targetVocabularyId}</Badge>
                        <MappingStatusBadge status={m.status} />
                        <Badge variant="outline" className="text-[10px]">{m.equivalence}</Badge>
                      </div>
                      {m.comment && (
                        <div className="mt-1.5 flex items-start gap-1 text-[10px] text-muted-foreground">
                          <MessageSquare size={10} className="mt-0.5 shrink-0" />
                          <span>{m.comment}</span>
                        </div>
                      )}
                      {m.mappedBy && (
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {t('concept_mapping.mapped_by')}: {m.mappedBy}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t('concept_mapping.approve')}
                        onClick={() => updateMapping(m.id, { status: 'approved' })}
                      >
                        <Check size={14} className="text-green-600" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t('concept_mapping.flag')}
                        onClick={() => updateMapping(m.id, { status: 'flagged' })}
                      >
                        <Flag size={14} className="text-orange-500" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t('common.delete')}
                        onClick={() => deleteMapping(m.id)}
                        className="text-destructive hover:text-destructive"
                      >
                        <X size={14} />
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Add mapping section */}
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('concept_mapping.add_mapping')}
          </p>

          {addingTarget ? (
            /* Mapping form */
            <Card className="p-3 space-y-3">
              <div>
                <p className="text-xs font-medium">{addingTarget.concept_name}</p>
                <div className="mt-1 flex gap-1">
                  <Badge variant="outline" className="text-[10px]">ID: {addingTarget.concept_id}</Badge>
                  <Badge variant="outline" className="text-[10px]">{addingTarget.vocabulary_id}</Badge>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="mb-1 text-[10px] text-muted-foreground">{t('concept_mapping.mapping_type')}</p>
                  <Select value={mappingType} onValueChange={(v) => setMappingType(v as MappingType)}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="maps_to">Maps to</SelectItem>
                      <SelectItem value="maps_to_value">Maps to value</SelectItem>
                      <SelectItem value="maps_to_unit">Maps to unit</SelectItem>
                      <SelectItem value="maps_to_operator">Maps to operator</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <p className="mb-1 text-[10px] text-muted-foreground">{t('concept_mapping.equivalence')}</p>
                  <Select value={equivalence} onValueChange={(v) => setEquivalence(v as MappingEquivalence)}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="equal">{t('concept_mapping.eq_equal')}</SelectItem>
                      <SelectItem value="equivalent">{t('concept_mapping.eq_equivalent')}</SelectItem>
                      <SelectItem value="wider">{t('concept_mapping.eq_wider')}</SelectItem>
                      <SelectItem value="narrower">{t('concept_mapping.eq_narrower')}</SelectItem>
                      <SelectItem value="inexact">{t('concept_mapping.eq_inexact')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Textarea
                className="text-xs"
                rows={2}
                placeholder={t('concept_mapping.comment_placeholder')}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddMapping}>{t('concept_mapping.save_mapping')}</Button>
                <Button size="sm" variant="outline" onClick={() => setAddingTarget(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </Card>
          ) : (
            /* Search for target concepts */
            <>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="h-8 pl-8 text-xs"
                    placeholder={t('concept_mapping.search_standard')}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  />
                </div>
                <Button size="sm" variant="outline" onClick={handleSearch} disabled={searching}>
                  {t('common.search')}
                </Button>
              </div>

              {searchResults.length > 0 && (
                <div className="mt-2 max-h-[300px] overflow-auto rounded-md border">
                  {searchResults.map((result) => (
                    <button
                      key={result.concept_id}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent/50"
                      onClick={() => setAddingTarget(result)}
                    >
                      <Plus size={12} className="shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <span className="text-muted-foreground">{result.concept_id}</span>{' '}
                        <span>{result.concept_name}</span>
                      </div>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{result.vocabulary_id}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
