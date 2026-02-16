import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ConceptFilters as ConceptFiltersType } from './concept-queries'
import type { FilterOptions } from './use-concepts'

interface ConceptFiltersProps {
  filters: ConceptFiltersType
  filterOptions: FilterOptions
  onFilterChange: (key: keyof ConceptFiltersType, value: string | null) => void
}

export function ConceptFilters({ filters, filterOptions, onFilterChange }: ConceptFiltersProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <Select
        value={filters.vocabularyId ?? '__all__'}
        onValueChange={(v) => onFilterChange('vocabularyId', v === '__all__' ? null : v)}
      >
        <SelectTrigger className="h-8 w-[150px] text-xs">
          <SelectValue placeholder={t('concepts.filter_vocabulary')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">{t('concepts.filter_all')}</SelectItem>
          {filterOptions.vocabularyIds.map((v) => (
            <SelectItem key={v} value={v}>{v}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.domainId ?? '__all__'}
        onValueChange={(v) => onFilterChange('domainId', v === '__all__' ? null : v)}
      >
        <SelectTrigger className="h-8 w-[140px] text-xs">
          <SelectValue placeholder={t('concepts.filter_domain')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">{t('concepts.filter_all')}</SelectItem>
          {filterOptions.domainIds.map((v) => (
            <SelectItem key={v} value={v}>{v}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.conceptClassId ?? '__all__'}
        onValueChange={(v) => onFilterChange('conceptClassId', v === '__all__' ? null : v)}
      >
        <SelectTrigger className="h-8 w-[150px] text-xs">
          <SelectValue placeholder={t('concepts.filter_class')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">{t('concepts.filter_all')}</SelectItem>
          {filterOptions.conceptClassIds.map((v) => (
            <SelectItem key={v} value={v}>{v}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.standardConcept ?? '__all__'}
        onValueChange={(v) => onFilterChange('standardConcept', v === '__all__' ? null : v)}
      >
        <SelectTrigger className="h-8 w-[160px] text-xs">
          <SelectValue placeholder={t('concepts.filter_standard')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">{t('concepts.filter_all')}</SelectItem>
          <SelectItem value="S">{t('concepts.filter_standard_s')}</SelectItem>
          <SelectItem value="C">{t('concepts.filter_standard_c')}</SelectItem>
          <SelectItem value="non-standard">{t('concepts.filter_standard_non')}</SelectItem>
        </SelectContent>
      </Select>

      <div className="relative ml-auto">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-8 w-[220px] pl-8 text-xs"
          placeholder={t('concepts.search_placeholder')}
          value={filters.searchText}
          onChange={(e) => onFilterChange('searchText', e.target.value)}
        />
      </div>
    </div>
  )
}
