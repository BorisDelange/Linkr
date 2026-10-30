import type { TFunction } from 'i18next'
import { Badge } from '@/components/ui/badge'
import type { DataTableColumn } from '@/components/ui/data-table'
import { getConceptSetI18n } from '@/lib/concept-mapping/i18n'
import { cn } from '@/lib/utils'
import type { ConceptSet, ConceptSetReviewStatus } from '@/types'

/**
 * The columns a concept set shows wherever the workspace's sets are listed —
 * the Vocabularies page and the mapping project's picker — so both read the same.
 */
export interface ConceptSetRow {
  set: ConceptSet
  name: string
  category: string
  subcategory: string
  dictionary: string
}

export function toConceptSetRow(set: ConceptSet, dictionaryNames: ReadonlyMap<string, string>, lang: string, t: TFunction): ConceptSetRow {
  const tr = getConceptSetI18n(set, lang)
  return {
    set,
    name: tr.name,
    category: tr.category ?? '',
    subcategory: tr.subcategory ?? '',
    dictionary: (set.dictionaryId && dictionaryNames.get(set.dictionaryId)) || t('data_dictionaries.local_name'),
  }
}

/** The status column's value for a set outside any review workflow (a local one). */
const NO_STATUS = 'none'

/** Every status filter value but `deprecated`: what a picker offers by default. */
export const NOT_DEPRECATED = ['draft', 'pending_review', 'approved', 'needs_revision', NO_STATUS]

// The hues of the data-dictionary app, as Linkr's tinted chips.
const STATUS_CLASS: Record<ConceptSetReviewStatus, string> = {
  draft: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  pending_review: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-400',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  needs_revision: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400',
  deprecated: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
}

export function conceptSetColumns<R extends ConceptSetRow>(t: TFunction): DataTableColumn<R>[] {
  const statusLabel = (status: string) => t(`vocabularies.review_status_${status}`)
  const statusBadge = (status: ConceptSetReviewStatus) => (
    <Badge variant="secondary" className={cn('max-w-full truncate', STATUS_CLASS[status])}>
      {statusLabel(status)}
    </Badge>
  )
  return [
    { id: 'category', header: t('concept_mapping.col_category'), accessor: (r) => r.category, filter: 'select', size: 150 },
    { id: 'subcategory', header: t('concept_mapping.col_subcategory'), accessor: (r) => r.subcategory, filter: 'select', size: 170 },
    { id: 'name', header: t('common.name'), accessor: (r) => r.name, filter: 'text', size: 280 },
    { id: 'items', header: t('vocabularies.col_items'), accessor: (r) => r.set.expression?.items?.length ?? 0, filter: 'number', size: 80, align: 'right' },
    { id: 'dictionary', header: t('vocabularies.col_dictionary'), accessor: (r) => r.dictionary, filter: 'select', size: 160 },
    {
      id: 'version',
      header: t('common.version'),
      accessor: (r) => r.set.version ?? '',
      filter: 'select',
      selectOptionOrder: (a, b) => b.localeCompare(a, undefined, { numeric: true }),
      size: 90,
    },
    {
      id: 'status',
      header: t('vocabularies.col_status'),
      accessor: (r) => r.set.reviewStatus ?? NO_STATUS,
      filter: 'select',
      selectOptionLabel: statusLabel,
      selectOptionRender: (o) => (o.value === NO_STATUS
        ? <span className="text-muted-foreground">{o.label}</span>
        : statusBadge(o.value as ConceptSetReviewStatus)),
      size: 130,
      align: 'center',
      cell: (r) => r.set.reviewStatus && statusBadge(r.set.reviewStatus),
    },
  ]
}
