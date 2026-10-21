import { useMemo } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'
import { ConceptStatsPopover } from './ConceptStatsPopover'
import type { ConceptRow } from './use-concepts'

/**
 * ConceptTable's trailing stats column, for the concept pickers. Stable
 * identity: ConceptTable rebuilds its columns whenever `rowAction` changes.
 */
export function useConceptStatsRowAction(
  dataSourceId: string | undefined,
  schemaMapping: SchemaMapping | undefined,
) {
  // Multi-dict sources pass the row's own dictionary.
  const defaultDictKey = schemaMapping?.concepts?.[0]?.key ?? ''
  return useMemo(
    () => ({
      render: (row: ConceptRow) => (
        <ConceptStatsPopover
          dataSourceId={dataSourceId}
          schemaMapping={schemaMapping}
          conceptId={row.concept_id}
          dictKey={(row._dict_key as string) ?? defaultDictKey}
        />
      ),
    }),
    [dataSourceId, schemaMapping, defaultDictKey],
  )
}
