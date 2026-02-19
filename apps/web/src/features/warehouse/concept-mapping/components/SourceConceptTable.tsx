import { useTranslation } from 'react-i18next'
import { Search, ChevronLeft, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { SourceConceptFilters, SourceConceptSorting } from '@/lib/concept-mapping/mapping-queries'
import type { SourceConceptRow } from '../MappingEditorTab'

interface SourceConceptTableProps {
  rows: SourceConceptRow[]
  totalCount: number
  page: number
  pageSize: number
  loading: boolean
  filters: SourceConceptFilters
  sorting: SourceConceptSorting | null
  filterOptions: Record<string, string[]>
  mappingStatusMap: Map<number, string>
  selectedConceptId: number | null
  onPageChange: (page: number) => void
  onFiltersChange: (filters: SourceConceptFilters) => void
  onSortingChange: (sorting: SourceConceptSorting | null) => void
  onSelectConcept: (id: number | null) => void
}

const STATUS_COLORS: Record<string, string> = {
  unmapped: 'bg-gray-300',
  mapped: 'bg-blue-500',
  approved: 'bg-green-500',
  flagged: 'bg-orange-500',
  invalid: 'bg-red-500',
}

export function SourceConceptTable({
  rows,
  totalCount,
  page,
  pageSize,
  loading,
  filters,
  sorting,
  filterOptions,
  mappingStatusMap,
  selectedConceptId,
  onPageChange,
  onFiltersChange,
  onSortingChange,
  onSelectConcept,
}: SourceConceptTableProps) {
  const { t } = useTranslation()
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const handleSort = (columnId: string) => {
    if (sorting?.columnId === columnId) {
      if (sorting.desc) onSortingChange({ columnId, desc: false })
      else onSortingChange(null)
    } else {
      onSortingChange({ columnId, desc: true })
    }
  }

  const SortIcon = ({ columnId }: { columnId: string }) => {
    if (sorting?.columnId !== columnId) return <ArrowUpDown size={12} className="opacity-30" />
    return sorting.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />
  }

  return (
    <div className="flex h-full flex-col border-r">
      {/* Filters bar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="relative flex-1 min-w-[160px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder={t('concept_mapping.search_concepts')}
            value={filters.searchText ?? ''}
            onChange={(e) => onFiltersChange({ ...filters, searchText: e.target.value || undefined })}
          />
        </div>
        {filterOptions.vocabulary_id && filterOptions.vocabulary_id.length > 0 && (
          <Select
            value={filters.vocabularyId ?? '__all__'}
            onValueChange={(v) => onFiltersChange({ ...filters, vocabularyId: v === '__all__' ? undefined : v })}
          >
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue placeholder={t('concept_mapping.all_vocabularies')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('concept_mapping.all_vocabularies')}</SelectItem>
              {filterOptions.vocabulary_id.map((v) => (
                <SelectItem key={v} value={v}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {filterOptions.domain_id && filterOptions.domain_id.length > 0 && (
          <Select
            value={filters.domainId ?? '__all__'}
            onValueChange={(v) => onFiltersChange({ ...filters, domainId: v === '__all__' ? undefined : v })}
          >
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue placeholder={t('concept_mapping.all_domains')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('concept_mapping.all_domains')}</SelectItem>
              {filterOptions.domain_id.map((v) => (
                <SelectItem key={v} value={v}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[24px_1fr_80px_80px_60px_60px] items-center gap-1 border-b bg-muted/30 px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        <span />
        <button className="flex items-center gap-1 text-left" onClick={() => handleSort('concept_name')}>
          {t('concept_mapping.col_name')} <SortIcon columnId="concept_name" />
        </button>
        <button className="flex items-center gap-1" onClick={() => handleSort('vocabulary_id')}>
          {t('concept_mapping.col_vocab')} <SortIcon columnId="vocabulary_id" />
        </button>
        <span>{t('concept_mapping.col_domain')}</span>
        <button className="flex items-center gap-1 justify-end" onClick={() => handleSort('record_count')}>
          {t('concept_mapping.col_records')} <SortIcon columnId="record_count" />
        </button>
        <button className="flex items-center gap-1 justify-end" onClick={() => handleSort('patient_count')}>
          {t('concept_mapping.col_patients')} <SortIcon columnId="patient_count" />
        </button>
      </div>

      {/* Table body */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-xs text-muted-foreground">{t('concept_mapping.no_concepts')}</p>
          </div>
        ) : (
          rows.map((row) => {
            const status = mappingStatusMap.get(row.concept_id) ?? 'unmapped'
            const isSelected = row.concept_id === selectedConceptId
            return (
              <button
                key={row.concept_id}
                className={`grid w-full grid-cols-[24px_1fr_80px_80px_60px_60px] items-center gap-1 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/50 ${
                  isSelected ? 'bg-accent' : ''
                }`}
                onClick={() => onSelectConcept(row.concept_id)}
              >
                <span className="flex justify-center">
                  <span className={`inline-block size-2 rounded-full ${STATUS_COLORS[status] ?? STATUS_COLORS.unmapped}`} />
                </span>
                <span className="truncate" title={row.concept_name}>
                  <span className="text-muted-foreground">{row.concept_id}</span>{' '}
                  {row.concept_name}
                </span>
                <span className="truncate text-muted-foreground">{row.vocabulary_id}</span>
                <span className="truncate text-muted-foreground">{row.domain_id}</span>
                <span className="text-right tabular-nums">{row.record_count?.toLocaleString()}</span>
                <span className="text-right tabular-nums">{row.patient_count?.toLocaleString()}</span>
              </button>
            )
          })
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between border-t px-3 py-1.5">
        <span className="text-[10px] text-muted-foreground">
          {totalCount.toLocaleString()} {t('concept_mapping.total_concepts')}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={page === 0} onClick={() => onPageChange(page - 1)}>
            <ChevronLeft size={14} />
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {page + 1} / {totalPages}
          </span>
          <Button variant="ghost" size="icon-sm" disabled={page >= totalPages - 1} onClick={() => onPageChange(page + 1)}>
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  )
}
