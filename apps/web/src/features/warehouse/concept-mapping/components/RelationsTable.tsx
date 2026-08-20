import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
import { StandardConceptBadge } from '@/lib/concept-mapping/standard-concept-badge'

export interface RelationRow {
  relationship_id: string
  concept_id: number
  concept_name: string
  vocabulary_id: string
  domain_id?: string
  concept_class_id?: string
  concept_code?: string
  standard_concept?: string
}

interface RelationsTableProps {
  relations: RelationRow[]
}

export function RelationsTable({ relations }: RelationsTableProps) {
  const { t } = useTranslation()

  const columns = useMemo<ConceptColumn<RelationRow>[]>(() => [
    {
      id: 'relationship_id',
      header: t('concept_mapping.concept_info_col_relationship'),
      accessor: (r) => r.relationship_id,
      filter: 'select',
      tooltip: 'text-xs text-muted-foreground',
      size: 130,
      minSize: 80,
    },
    {
      id: 'vocabulary_id',
      header: t('concept_mapping.col_vocabulary'),
      accessor: (r) => r.vocabulary_id,
      filter: 'select',
      size: 80,
      minSize: 50,
    },
    {
      id: 'concept_name',
      header: t('concept_mapping.col_name'),
      accessor: (r) => r.concept_name,
      filter: 'text',
      size: 180,
      minSize: 100,
    },
    {
      id: 'concept_id',
      header: t('concept_mapping.col_concept_id'),
      accessor: (r) => r.concept_id,
      cell: (r) => <span className="font-mono text-xs">{r.concept_id}</span>,
      filter: 'number',
      hidden: true,
      size: 70,
      minSize: 50,
    },
    {
      id: 'concept_code',
      header: t('concept_mapping.col_concept_code'),
      accessor: (r) => r.concept_code,
      cell: (r) => <span className="font-mono text-xs">{r.concept_code ?? ''}</span>,
      filter: 'text',
      hidden: true,
      size: 80,
      minSize: 50,
    },
    {
      id: 'domain_id',
      header: t('concept_mapping.col_domain'),
      accessor: (r) => r.domain_id,
      filter: 'select',
      hidden: true,
      size: 80,
      minSize: 50,
    },
    {
      id: 'concept_class_id',
      header: t('concept_mapping.col_concept_class'),
      accessor: (r) => r.concept_class_id,
      filter: 'select',
      hidden: true,
      size: 90,
      minSize: 50,
    },
    {
      id: 'standard_concept',
      header: t('concept_mapping.col_std'),
      accessor: (r) => r.standard_concept,
      cell: (r) => <StandardConceptBadge value={r.standard_concept} />,
      filter: 'select',
      size: 40,
      minSize: 30,
    },
  ], [t])

  return (
    <ConceptDataTable
      cellTooltips="all"
      pageSize={100}
      data={relations}
      columns={columns}
      rowKey={(r) => `${r.relationship_id}__${r.concept_id}`}
      emptyMessage={t('concept_mapping.concept_info_no_relations')}
    />
  )
}
