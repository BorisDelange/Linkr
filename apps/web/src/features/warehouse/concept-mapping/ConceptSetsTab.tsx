import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, BookOpen, Trash2, RefreshCw, Globe, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
  const { conceptSets, deleteConceptSet, updateMappingProject } = useConceptMappingStore()

  const [importOpen, setImportOpen] = useState(false)
  const [setToDelete, setSetToDelete] = useState<ConceptSet | null>(null)

  const linkedSets = conceptSets.filter((cs) => project.conceptSetIds.includes(cs.id))

  const handleDelete = async () => {
    if (!setToDelete) return
    // Remove from project
    await updateMappingProject(project.id, {
      conceptSetIds: project.conceptSetIds.filter((id) => id !== setToDelete.id),
    })
    await deleteConceptSet(setToDelete.id)
    setSetToDelete(null)
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
        <TabsList className="w-fit">
          <TabsTrigger value="project-sets">{t('concept_mapping.cs_project_sets')}</TabsTrigger>
          <TabsTrigger value="vocabulary">{t('concept_mapping.cs_vocabulary_ref')}</TabsTrigger>
          <TabsTrigger value="browse" disabled={!project.vocabularyDataSourceId}>
            {t('concept_mapping.cs_browse')}
          </TabsTrigger>
        </TabsList>

        {/* Sub-tab 1: Project Concept Sets */}
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

            {linkedSets.length === 0 ? (
              <Card>
                <div className="flex flex-col items-center py-10">
                  <BookOpen size={32} className="text-muted-foreground" />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {t('concept_mapping.cs_empty')}
                  </p>
                </div>
              </Card>
            ) : (
              <div className="grid gap-3">
                {linkedSets.map((cs) => {
                  const domainSummary = getDomainSummary(cs)
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
                            {domainSummary.map(([domain, count]) => (
                              <Badge key={domain} variant="outline" className="text-[10px]">
                                {domain}: {count}
                              </Badge>
                            ))}
                          </div>
                          {cs.sourceUrl && (
                            <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                              <Globe size={10} />
                              <span className="truncate">{cs.sourceUrl}</span>
                            </div>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon-sm" title={t('concept_mapping.cs_resolve')}>
                            <RefreshCw size={14} />
                          </Button>
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
