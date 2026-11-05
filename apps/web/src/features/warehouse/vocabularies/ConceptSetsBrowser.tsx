import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getStorage } from '@/lib/storage'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { ConceptSetDetailSheet } from '@/features/warehouse/concept-mapping/ConceptSetDetailSheet'
import type { ConceptSet } from '@/types'
import { conceptSetColumns, toConceptSetRow, type ConceptSetRow } from './concept-set-columns'

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

  const rows = useMemo<ConceptSetRow[]>(() => conceptSets
    .filter((s) => s.workspaceId === workspaceId)
    .map((set) => toConceptSetRow(set, dictionaryNames, i18n.language, t)), [conceptSets, workspaceId, dictionaryNames, i18n.language, t])

  const columns = useMemo<DataTableColumn<ConceptSetRow>[]>(() => [
    ...conceptSetColumns<ConceptSetRow>(t),
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
