import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getConceptSetI18n } from '@/lib/concept-mapping/i18n'
import { getStorage } from '@/lib/storage'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { ConceptSetDetailSheet } from '@/features/warehouse/concept-mapping/ConceptSetDetailSheet'
import type { ConceptSet } from '@/types'

interface Row {
  set: ConceptSet
  name: string
  category: string
  subcategory: string
  dictionary: string
}

/**
 * Every concept set of the workspace's data dictionaries, with the set's detail
 * sheet (concepts, resolution, units) one click away.
 */
export function ConceptSetsBrowser({ workspaceId }: { workspaceId: string }) {
  const { t, i18n } = useTranslation()
  const conceptSets = useConceptMappingStore((s) => s.conceptSets)
  const conceptSetsLoaded = useConceptMappingStore((s) => s.conceptSetsLoaded)
  const loadConceptSets = useConceptMappingStore((s) => s.loadConceptSets)
  const [dictionaryNames, setDictionaryNames] = useState<Map<string, string>>(new Map())
  const [detail, setDetail] = useState<ConceptSet | null>(null)

  useEffect(() => {
    if (!conceptSetsLoaded) void loadConceptSets()
  }, [conceptSetsLoaded, loadConceptSets])

  useEffect(() => {
    getStorage().dataDictionaries.getByWorkspace(workspaceId)
      .then((list) => setDictionaryNames(new Map(list.map((d) => [d.id, d.name]))))
      .catch(() => setDictionaryNames(new Map()))
  }, [workspaceId])

  const rows = useMemo<Row[]>(() => conceptSets
    .filter((s) => s.workspaceId === workspaceId)
    .map((set) => {
      const tr = getConceptSetI18n(set, i18n.language)
      return {
        set,
        name: tr.name,
        category: tr.category ?? '',
        subcategory: tr.subcategory ?? '',
        dictionary: (set.dictionaryId && dictionaryNames.get(set.dictionaryId)) || t('data_dictionaries.local_name'),
      }
    }), [conceptSets, workspaceId, dictionaryNames, i18n.language, t])

  const columns = useMemo<DataTableColumn<Row>[]>(() => [
    { id: 'category', header: t('concept_mapping.col_category'), accessor: (r) => r.category, filter: 'select', size: 160 },
    { id: 'subcategory', header: t('concept_mapping.col_subcategory'), accessor: (r) => r.subcategory, filter: 'select', size: 180 },
    { id: 'name', header: t('common.name'), accessor: (r) => r.name, filter: 'text', size: 300 },
    { id: 'items', header: t('vocabularies.col_items'), accessor: (r) => r.set.expression?.items?.length ?? 0, filter: 'number', size: 80, align: 'right' },
    { id: 'dictionary', header: t('data_dictionaries.title'), accessor: (r) => r.dictionary, filter: 'select', size: 180 },
    { id: 'version', header: t('common.version'), accessor: (r) => r.set.version ?? '', size: 80 },
    {
      id: 'info',
      header: '',
      sortable: false,
      size: 36,
      accessor: () => '',
      cell: (r) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-primary"
              aria-label={t('concept_mapping.cs_view_detail')}
              onClick={() => setDetail(r.set)}
            >
              <Info size={12} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('concept_mapping.cs_view_detail')}</TooltipContent>
        </Tooltip>
      ),
    },
  ], [t])

  return (
    <>
      <DataTable
        data={rows}
        columns={columns}
        rowKey={(r) => r.set.id}
        pageSize={100}
        initialSorting={{ columnId: 'category', desc: false }}
        emptyMessage={t('vocabularies.concept_sets_empty')}
      />
      <ConceptSetDetailSheet
        conceptSet={detail}
        open={detail !== null}
        onOpenChange={(open) => { if (!open) setDetail(null) }}
      />
    </>
  )
}
