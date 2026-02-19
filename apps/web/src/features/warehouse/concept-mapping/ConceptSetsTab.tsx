import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, BookOpen, Trash2, RefreshCw, Globe, Upload, Search, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { ImportConceptSetDialog } from './ImportConceptSetDialog'
import type { MappingProject, DataSource, ConceptSet } from '@/types'

interface ConceptSetsTabProps {
  project: MappingProject
  dataSource?: DataSource
}

export function ConceptSetsTab({ project }: ConceptSetsTabProps) {
  const { t } = useTranslation()
  const { conceptSets, deleteConceptSet, updateMappingProject, updateConceptSet } = useConceptMappingStore()

  const [importOpen, setImportOpen] = useState(false)
  const [setToDelete, setSetToDelete] = useState<ConceptSet | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  // Filters
  const [searchText, setSearchText] = useState('')
  const [filterCategory, setFilterCategory] = useState<string>('__all__')
  const [filterSubcategory, setFilterSubcategory] = useState<string>('__all__')
  const [filterProvenance, setFilterProvenance] = useState<string>('__all__')

  const linkedSets = conceptSets.filter((cs) => project.conceptSetIds.includes(cs.id))

  // Compute unique filter values
  const { categories, subcategories, provenances } = useMemo(() => {
    const cats = new Set<string>()
    const subs = new Set<string>()
    const provs = new Set<string>()
    for (const cs of linkedSets) {
      if (cs.category) cats.add(cs.category)
      if (cs.subcategory) subs.add(cs.subcategory)
      if (cs.provenance) provs.add(cs.provenance)
    }
    return {
      categories: [...cats].sort(),
      subcategories: [...subs].sort(),
      provenances: [...provs].sort(),
    }
  }, [linkedSets])

  // Apply filters
  const filteredSets = useMemo(() => {
    return linkedSets.filter((cs) => {
      if (searchText) {
        const q = searchText.toLowerCase()
        const matches =
          cs.name.toLowerCase().includes(q) ||
          (cs.category?.toLowerCase().includes(q) ?? false) ||
          (cs.subcategory?.toLowerCase().includes(q) ?? false) ||
          (cs.provenance?.toLowerCase().includes(q) ?? false)
        if (!matches) return false
      }
      if (filterCategory !== '__all__' && cs.category !== filterCategory) return false
      if (filterSubcategory !== '__all__' && cs.subcategory !== filterSubcategory) return false
      if (filterProvenance !== '__all__' && cs.provenance !== filterProvenance) return false
      return true
    })
  }, [linkedSets, searchText, filterCategory, filterSubcategory, filterProvenance])

  const handleDelete = async () => {
    if (!setToDelete) return
    await updateMappingProject(project.id, {
      conceptSetIds: project.conceptSetIds.filter((id) => id !== setToDelete.id),
    })
    await deleteConceptSet(setToDelete.id)
    setSetToDelete(null)
  }

  /** Update a concept set from its remote source URL. */
  const handleUpdateFromRemote = async (cs: ConceptSet) => {
    if (!cs.sourceUrl) return
    setUpdatingId(cs.id)
    try {
      const resp = await fetch(cs.sourceUrl)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = await resp.json()

      // Re-parse the JSON
      const obj = json as Record<string, unknown>
      if (!obj.expression || typeof obj.expression !== 'object') return
      const expr = obj.expression as Record<string, unknown>
      if (!Array.isArray(expr.items)) return

      // Extract translated name
      const lang = document.documentElement.lang?.substring(0, 2) ?? 'en'
      const meta = obj.metadata as Record<string, unknown> | undefined
      const translations = meta?.translations as Record<string, Record<string, string>> | undefined
      const tr = translations?.[lang] ?? translations?.en
      const createdBy = meta?.createdByDetails as Record<string, string> | undefined

      await updateConceptSet(cs.id, {
        name: tr?.name ?? String(obj.name ?? cs.name),
        description: obj.description ? String(obj.description) : cs.description,
        expression: { items: expr.items as ConceptSet['expression']['items'] },
        category: tr?.category ?? cs.category,
        subcategory: tr?.subcategory ?? cs.subcategory,
        provenance: createdBy?.affiliation ?? cs.provenance,
        updatedAt: new Date().toISOString(),
      })
    } catch (err) {
      console.error('Failed to update concept set from remote:', err)
    } finally {
      setUpdatingId(null)
    }
  }

  const getDomainSummary = (cs: ConceptSet) => {
    const domains = new Map<string, number>()
    for (const item of cs.expression.items) {
      const d = item.concept.domainId || 'Unknown'
      domains.set(d, (domains.get(d) ?? 0) + 1)
    }
    return Array.from(domains.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
  }

  return (
    <div className="h-full overflow-auto p-4">
      <Tabs defaultValue="project-sets">
        <div className="flex justify-center">
          <TabsList className="w-fit">
            <TabsTrigger value="project-sets">{t('concept_mapping.cs_project_sets')}</TabsTrigger>
            <TabsTrigger value="vocabulary">{t('concept_mapping.cs_vocabulary_ref')}</TabsTrigger>
            <TabsTrigger value="browse" disabled={!project.vocabularyDataSourceId}>
              {t('concept_mapping.cs_browse')}
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Sub-tab 1: Concept Sets */}
        <TabsContent value="project-sets">
          <div className="mx-auto max-w-3xl">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {t('concept_mapping.cs_description')}
              </p>
              <Button size="sm" onClick={() => setImportOpen(true)}>
                <Plus size={14} />
                {t('concept_mapping.cs_add')}
              </Button>
            </div>

            {/* Filters */}
            {linkedSets.length > 0 && (
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="relative min-w-[180px] flex-1">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="h-8 pl-8 text-xs"
                    placeholder={t('concept_mapping.cs_filter_search')}
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                  />
                </div>
                {categories.length > 0 && (
                  <Select value={filterCategory} onValueChange={setFilterCategory}>
                    <SelectTrigger className="h-8 w-[140px] text-xs">
                      <SelectValue placeholder={t('concept_mapping.cs_filter_category')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">{t('concept_mapping.cs_filter_all_categories')}</SelectItem>
                      {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {subcategories.length > 0 && (
                  <Select value={filterSubcategory} onValueChange={setFilterSubcategory}>
                    <SelectTrigger className="h-8 w-[160px] text-xs">
                      <SelectValue placeholder={t('concept_mapping.cs_filter_subcategory')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">{t('concept_mapping.cs_filter_all_subcategories')}</SelectItem>
                      {subcategories.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {provenances.length > 0 && (
                  <Select value={filterProvenance} onValueChange={setFilterProvenance}>
                    <SelectTrigger className="h-8 w-[160px] text-xs">
                      <SelectValue placeholder={t('concept_mapping.cs_filter_provenance')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">{t('concept_mapping.cs_filter_all_provenances')}</SelectItem>
                      {provenances.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {linkedSets.length === 0 ? (
              <Card>
                <div className="flex flex-col items-center py-10">
                  <BookOpen size={32} className="text-muted-foreground" />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {t('concept_mapping.cs_empty')}
                  </p>
                </div>
              </Card>
            ) : filteredSets.length === 0 ? (
              <Card>
                <div className="flex flex-col items-center py-10">
                  <Search size={32} className="text-muted-foreground" />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {t('common.no_results')}
                  </p>
                </div>
              </Card>
            ) : (
              <div className="grid gap-3">
                <p className="text-xs text-muted-foreground">
                  {filteredSets.length} / {linkedSets.length} concept sets
                </p>
                {filteredSets.map((cs) => {
                  const domainSummary = getDomainSummary(cs)
                  const isUpdating = updatingId === cs.id
                  return (
                    <Card key={cs.id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{cs.name}</span>
                            <Badge variant="secondary" className="text-[10px]">
                              {cs.expression.items.length} {t('concept_mapping.cs_concepts')}
                            </Badge>
                            {cs.resolvedConceptIds && (
                              <Badge variant="outline" className="text-[10px]">
                                {cs.resolvedConceptIds.length} {t('concept_mapping.cs_resolved')}
                              </Badge>
                            )}
                          </div>
                          {cs.description && (
                            <p className="mt-1 text-xs text-muted-foreground">{cs.description}</p>
                          )}
                          <div className="mt-2 flex flex-wrap gap-1">
                            {cs.category && (
                              <Badge variant="outline" className="text-[10px]">{cs.category}</Badge>
                            )}
                            {cs.subcategory && (
                              <Badge variant="outline" className="text-[10px]">{cs.subcategory}</Badge>
                            )}
                            {domainSummary.map(([domain, count]) => (
                              <Badge key={domain} variant="secondary" className="text-[10px]">
                                {domain}: {count}
                              </Badge>
                            ))}
                          </div>
                          {(cs.provenance || cs.sourceUrl) && (
                            <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                              {cs.provenance && <span>{cs.provenance}</span>}
                              {cs.provenance && cs.sourceUrl && <span>-</span>}
                              {cs.sourceUrl && (
                                <span className="flex items-center gap-1 truncate">
                                  <Globe size={10} />
                                  <span className="truncate">{cs.sourceUrl}</span>
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex gap-1">
                          {cs.sourceUrl && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title={t('concept_mapping.cs_update_remote')}
                              disabled={isUpdating}
                              onClick={() => handleUpdateFromRemote(cs)}
                            >
                              {isUpdating ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <RefreshCw size={14} />
                              )}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setSetToDelete(cs)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>
                    </Card>
                  )
                })}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Sub-tab 2: Vocabulary Reference (future) */}
        <TabsContent value="vocabulary">
          <div className="mx-auto max-w-3xl">
            <Card>
              <div className="flex flex-col items-center py-10">
                <Upload size={32} className="text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">{t('concept_mapping.vocab_ref_title')}</p>
                <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                  {t('concept_mapping.vocab_ref_description')}
                </p>
                <Button className="mt-4" disabled>
                  <Upload size={14} />
                  {t('concept_mapping.vocab_import_athena')}
                  <Badge variant="secondary" className="ml-2 text-[10px]">{t('common.coming_soon')}</Badge>
                </Button>
              </div>
            </Card>
          </div>
        </TabsContent>

        {/* Sub-tab 3: Browse Vocabulary (future) */}
        <TabsContent value="browse">
          <div className="mx-auto max-w-3xl">
            <Card>
              <div className="flex flex-col items-center py-10">
                <BookOpen size={32} className="text-muted-foreground" />
                <p className="mt-3 text-sm text-muted-foreground">
                  {t('concept_mapping.vocab_browse_empty')}
                </p>
              </div>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <ImportConceptSetDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        project={project}
      />

      <AlertDialog open={!!setToDelete} onOpenChange={(open) => { if (!open) setSetToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.cs_delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.cs_delete_description', { name: setToDelete?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
