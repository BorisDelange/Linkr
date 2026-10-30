import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus, BookOpen, Trash2, Info, X, CheckCircle2, Pencil, SquareX, Settings2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNavigate } from 'react-router'
import { paths } from '@/lib/paths'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
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
import { getStorage } from '@/lib/storage'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useDataSourceStore } from '@/stores/data-source-store'
import { PickConceptSetsDialog } from './PickConceptSetsDialog'
import { ConceptSetDetailSheet } from './ConceptSetDetailSheet'
import { VocabularyBrowser } from './components/VocabularyBrowser'
import type { MappingProject, DataSource, ConceptSet, DatabaseConnectionConfig } from '@/types'
import { conceptSetColumns, toConceptSetRow, type ConceptSetRow } from '@/features/warehouse/vocabularies/concept-set-columns'
import { localized } from '@/lib/localized'
import { vocabularyDataSourceIdFor } from '@/lib/vocabulary-library/resolve'


/** A linked concept set, with the source concepts mapped onto it. */
interface CsRow extends ConceptSetRow {
  /** Distinct source concepts mapped onto this concept set. */
  mappedCount: number
  /** Names of those source concepts (for the hover tooltip). */
  mappedSources: string[]
}

interface ConceptSetsTabProps {
  project: MappingProject
  dataSource?: DataSource
}

export function ConceptSetsTab({ project }: ConceptSetsTabProps) {
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('concept-mapping:write')
  const lang = i18n.language
  const { conceptSets, mappings, updateMappingProject } = useConceptMappingStore()

  const [importOpen, setImportOpen] = useState(false)

  // Detail sheet
  const [detailConceptSet, setDetailConceptSet] = useState<ConceptSet | null>(null)

  // Bulk selection (edit mode)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [visible, setVisible] = useState<CsRow[]>([])
  const [dictionaryNames, setDictionaryNames] = useState<Map<string, string>>(new Map())

  const navigate = useNavigate()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  useEffect(() => {
    getStorage().dataDictionaries.getByWorkspace(project.workspaceId)
      .then((list) => setDictionaryNames(new Map(list.map((d) => [d.id, d.name]))))
      .catch(() => setDictionaryNames(new Map()))
  }, [project.workspaceId])

  const linkedSets = useMemo(
    () => conceptSets.filter((cs) => (project.conceptSetIds ?? []).includes(cs.id)),
    [conceptSets, project.conceptSetIds],
  )

  // Distinct source concepts mapped onto each concept set. A source counts when
  // one of its mappings targets a concept in the set (resolved ids if available,
  // else the expression items) with a real status — exclude rejected/invalid/
  // ignored/suggested, which are not actual alignments.
  const mappedByCsId = useMemo(() => {
    const REAL: ReadonlySet<string> = new Set(['unchecked', 'approved', 'flagged'])
    const realMappings = mappings.filter((m) => m.projectId === project.id && REAL.has(m.status) && m.targetConceptId > 0)
    const byCs = new Map<string, { count: number; sources: string[] }>()
    for (const cs of linkedSets) {
      const targetIds = new Set<number>(
        cs.resolvedConceptIds && cs.resolvedConceptIds.length > 0
          ? cs.resolvedConceptIds
          : cs.expression.items.map((it) => it.concept.conceptId),
      )
      const seen = new Set<number>()
      const sources: string[] = []
      for (const m of realMappings) {
        if (targetIds.has(m.targetConceptId) && !seen.has(m.sourceConceptId)) {
          seen.add(m.sourceConceptId)
          sources.push(`${m.sourceVocabularyId} - ${m.sourceConceptCode} - ${m.sourceConceptName}`)
        }
      }
      byCs.set(cs.id, { count: sources.length, sources })
    }
    return byCs
  }, [mappings, linkedSets, project.id])

  const rows = useMemo<CsRow[]>(() => linkedSets.map((cs) => {
    const mapped = mappedByCsId.get(cs.id) ?? { count: 0, sources: [] }
    return { ...toConceptSetRow(cs, dictionaryNames, lang, t), mappedCount: mapped.count, mappedSources: mapped.sources }
  }), [linkedSets, mappedByCsId, dictionaryNames, lang, t])

  const columns = useMemo<DataTableColumn<CsRow>[]>(() => {
    const pick: DataTableColumn<CsRow> = {
      id: 'pick',
      header: t('concept_mapping.cs_select_all'),
      headerCell: () => {
        const n = visible.filter((r) => selectedIds.has(r.set.id)).length
        return (
          <Checkbox
            checked={n > 0 && n === visible.length ? true : n > 0 ? 'indeterminate' : false}
            disabled={visible.length === 0}
            aria-label={t('concept_mapping.cs_select_all')}
            onCheckedChange={() => setSelectedIds((prev) => {
              const next = new Set(prev)
              const all = n === visible.length
              for (const r of visible) {
                if (all) next.delete(r.set.id)
                else next.add(r.set.id)
              }
              return next
            })}
          />
        )
      },
      size: 36,
      sortable: false,
      accessor: (r) => (selectedIds.has(r.set.id) ? 1 : 0),
      cell: (r) => (
        <Checkbox
          checked={selectedIds.has(r.set.id)}
          onCheckedChange={() => setSelectedIds((prev) => {
            const next = new Set(prev)
            if (next.has(r.set.id)) next.delete(r.set.id)
            else next.add(r.set.id)
            return next
          })}
        />
      ),
    }
    return [
      ...(selectionMode ? [pick] : []),
      ...conceptSetColumns<CsRow>(t),
      { id: 'provenance', header: t('concept_mapping.cs_filter_provenance'), accessor: (r) => r.set.provenance ?? '', filter: 'select', size: 120, hidden: true },
      {
        id: 'mappedCount',
        header: t('concept_mapping.cs_col_mapped_count'),
        accessor: (r) => r.mappedCount,
        filter: 'range',
        size: 90,
        align: 'center',
        cell: (r) => {
          const badge = <Badge variant="secondary">{r.mappedCount}</Badge>
          if (r.mappedCount === 0) return badge
          return (
            <Tooltip>
              <TooltipTrigger asChild><span className="cursor-default">{badge}</span></TooltipTrigger>
              <TooltipContent side="left" className="max-w-sm">
                <ul className="space-y-0.5 text-[11px]">
                  {r.mappedSources.slice(0, 10).map((src, i) => <li key={i} className="truncate">- {src}</li>)}
                  {r.mappedSources.length > 10 && <li className="text-muted-foreground">…</li>}
                </ul>
              </TooltipContent>
            </Tooltip>
          )
        },
      },
      ...(selectionMode ? [] : [{
        id: 'info',
        header: '',
        sortable: false,
        size: 36,
        accessor: () => '',
        cell: (r: CsRow) => (
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-primary"
            title={t('concept_mapping.cs_view_detail')}
            onClick={() => setDetailConceptSet(r.set)}
          >
            <Info size={12} />
          </Button>
        ),
      } satisfies DataTableColumn<CsRow>]),
    ]
  }, [t, selectionMode, selectedIds, visible])

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return
    await updateMappingProject(project.id, {
      conceptSetIds: (project.conceptSetIds ?? []).filter((id) => !selectedIds.has(id)),
    })
    setSelectedIds(new Set())
    setSelectionMode(false)
    setBulkDeleteOpen(false)
  }

  const exitSelectionMode = () => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }

  // The workspace library (or, until it is filled, this project's own older
  // vocabulary database).
  const vocabDsId = vocabularyDataSourceIdFor(project, dataSources)
  const vocabDs = vocabDsId ? dataSources.find((ds) => ds.id === vocabDsId) : null
  const libraryVocabularies = vocabDs ? (vocabDs.connectionConfig as DatabaseConnectionConfig).vocabularies ?? [] : []
  const openVocabularyLibrary = () => navigate(paths.warehouseVocabularies(project.workspaceId, 'ohdsi', 'library'))

  return (
    <div className="h-full overflow-auto px-4 pb-4">
      {/* The vocabulary reference comes first: importing ATHENA is what makes
          mapping possible at all, and concept sets are a refinement on top. */}
      <Tabs defaultValue="vocabulary">
        <div className="flex justify-center">
          <TabsList className="w-fit">
            <TabsTrigger value="vocabulary">{t('concept_mapping.cs_vocabulary_ref')}</TabsTrigger>
            <TabsTrigger value="concept-sets">{t('concept_mapping.cs_project_sets')}</TabsTrigger>
          </TabsList>
        </div>

        {/* ================================================================
            Tab 1: Concept Sets — DataTable
        ================================================================ */}
        <TabsContent value="concept-sets">
          <div className="mx-auto max-w-7xl">
            {/* Toolbar */}
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {t('concept_mapping.cs_description')}
              </p>
              <div className="flex gap-2">
                {linkedSets.length > 0 && (
                  <>
                    {selectionMode ? (
                      <Button size="sm" variant="outline" onClick={exitSelectionMode}>
                        <X size={14} />
                        {t('concept_mapping.cs_exit_selection')}
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled={!canWrite} onClick={() => setSelectionMode(true)}>
                        <Pencil size={14} />
                        {t('concept_mapping.cs_edit')}
                      </Button>
                    )}
                  </>
                )}
                <Button size="sm" disabled={!canWrite} onClick={() => setImportOpen(true)}>
                  <Plus size={14} />
                  {t('concept_mapping.cs_add')}
                </Button>
              </div>
            </div>

            {/* Edit mode toolbar */}
            {selectionMode && selectedIds.size > 0 && (
              <div className="mb-3 flex items-center gap-3">
                <Button variant="outline" size="sm-tight" onClick={() => setSelectedIds(new Set())}>
                  <SquareX size={12} />
                  {t('concept_mapping.cs_deselect_all')}
                </Button>
                <Button variant="destructive" size="sm-tight" onClick={() => setBulkDeleteOpen(true)}>
                  <Trash2 size={12} />
                  {t('concept_mapping.cs_delete_selected', { count: selectedIds.size })}
                </Button>
              </div>
            )}

            {/* The "no concept sets linked" empty state is an onboarding card;
                once one is linked, the table shows even when its filters
                narrow it to nothing, so they can be cleared. */}
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
              <DataTable
                data={rows}
                columns={columns}
                rowKey={(r) => r.set.id}
                pageSize={25}
                initialSorting={{ columnId: 'category', desc: false }}
                // The header checkbox reads `visible`: keep the same array for
                // the same rows, or each report triggers the next.
                onVisibleRowsChange={(next) => setVisible((prev) => (
                  prev.length === next.length && prev.every((r, i) => r.set.id === next[i].set.id) ? prev : next
                ))}
              />
            )}
          </div>
        </TabsContent>

        {/* ================================================================
            Tab 2: Vocabulary Reference (import + browse merged)
        ================================================================ */}
        <TabsContent value="vocabulary">
          <div className="mx-auto max-w-4xl space-y-4">
            {vocabDs ? (
              /* Vocabulary already imported — compact status + browse below */
              <>
                <Card className="p-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 size={20} className="shrink-0 text-green-500" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {(vocabDs.connectionConfig as DatabaseConnectionConfig).vocabularyLibrary
                          ? t('concept_mapping.vocab_library_summary', { count: libraryVocabularies.length })
                          : localized(vocabDs.name, i18n.language)}
                      </p>
                      {libraryVocabularies.length > 0 && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {libraryVocabularies.map((v) => v.vocabularyId).join(', ')}
                        </p>
                      )}
                    </div>
                    <Button size="sm" variant="outline" onClick={openVocabularyLibrary}>
                      <Settings2 size={14} />
                      {t('concept_mapping.vocab_library_manage')}
                    </Button>
                  </div>
                </Card>

                <VocabularyBrowser dataSourceId={vocabDs.id} />
              </>
            ) : (
              /* No vocabulary in the workspace: it is imported on the workspace Vocabularies page */
              <Card className="p-6">
                <div className="flex flex-col items-center">
                  <BookOpen size={32} className="text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">{t('concept_mapping.vocab_library_empty_title')}</p>
                  <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                    {t('concept_mapping.vocab_library_empty_hint')}
                  </p>
                  <Button size="sm" variant="outline" className="mt-4" onClick={openVocabularyLibrary}>
                    <Settings2 size={14} />
                    {t('concept_mapping.vocab_library_manage')}
                  </Button>
                </div>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>

      <PickConceptSetsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        project={project}
      />

      <ConceptSetDetailSheet
        conceptSet={detailConceptSet}
        open={!!detailConceptSet}
        onOpenChange={(open) => { if (!open) setDetailConceptSet(null) }}
      />

      {/* Bulk delete dialog */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.cs_bulk_delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.cs_bulk_delete_description', { count: selectedIds.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={handleBulkDelete}>{t('concept_mapping.cs_detach')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
