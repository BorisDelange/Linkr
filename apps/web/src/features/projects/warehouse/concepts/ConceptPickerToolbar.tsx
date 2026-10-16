import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { columnLabel } from '@/lib/format-helpers'
import type { ColumnDescriptor, ConceptFilters, ConceptFilterValue } from './concept-queries'

interface ConceptPickerToolbarProps {
  availableColumns: ColumnDescriptor[]
  filters: ConceptFilters
  filterOptions: Record<string, string[]>
  onFilterChange: (key: string, value: ConceptFilterValue) => void
  /** Extra controls after the search (e.g. importing a saved list). */
  children?: ReactNode
}

/** The Concepts page's filters popover and fuzzy search, with the same
 *  controls, order and sizing: for the concept pickers and a database's
 *  Concepts tab. */
export function ConceptPickerToolbar({
  availableColumns,
  filters,
  filterOptions,
  onFilterChange,
  children,
}: ConceptPickerToolbarProps) {
  const { t } = useTranslation()

  // Typed locally, committed on Enter / the Search button: a keystroke-debounced
  // query would fire a full fuzzy scan over the dictionary per character.
  const [pendingSearch, setPendingSearch] = useState('')
  const commitSearch = () => onFilterChange('_searchFuzzy', pendingSearch.trim() || null)
  const clearSearch = () => {
    setPendingSearch('')
    if (filters._searchFuzzy) onFilterChange('_searchFuzzy', null)
  }

  const filterableColumns = useMemo(
    () => availableColumns.filter((c) => c.filterable && (filterOptions[c.id]?.length ?? 0) > 0),
    [availableColumns, filterOptions],
  )
  const selectedFilterValues = (columnId: string) => {
    const raw = filters[columnId]
    return Array.isArray(raw) ? raw : raw ? [raw] : []
  }
  const standardOptionLabel = (value: string) =>
    value === 'S' ? t('concepts.standard_s')
      : value === 'C' ? t('concepts.standard_c')
        : t('concepts.standard_non')
  const activeFilterCount = filterableColumns.reduce(
    (n, col) => n + (selectedFilterValues(col.id).length > 0 ? 1 : 0),
    0,
  )

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={`h-8 w-8 shrink-0 ${activeFilterCount > 0 ? 'text-primary' : ''}`}
                >
                  <SlidersHorizontal size={14} />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{t('common.filters')}</TooltipContent>
          </Tooltip>
          <PopoverContent
            align="start"
            className="w-[280px] space-y-3 p-3"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            {filterableColumns.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('concepts.no_filters')}</p>
            ) : (
              filterableColumns.map((col) => (
                <div key={col.id} className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {columnLabel(col.id)}
                  </p>
                  <MultiSelectFilter
                    value={selectedFilterValues(col.id)}
                    options={(filterOptions[col.id] ?? []).map((v) =>
                      col.id === 'standard_concept'
                        ? { value: v, label: standardOptionLabel(v) }
                        : v,
                    )}
                    placeholder={columnLabel(col.id)}
                    onChange={(next) => onFilterChange(col.id, next.length ? next : null)}
                    triggerClass="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus:border-primary"
                    popoverWidthClass="w-[300px]"
                  />
                </div>
              ))
            )}
          </PopoverContent>
        </Popover>

        <div className="relative min-w-0 flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 pr-7 text-xs"
            value={pendingSearch}
            onChange={(e) => setPendingSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitSearch() }
              else if (e.key === 'Escape') { e.preventDefault(); clearSearch() }
            }}
            placeholder={t('concepts.search_concepts')}
          />
          {pendingSearch && (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={t('common.clear')}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" onClick={commitSearch}>
          {t('common.search')}
        </Button>

        {children}
      </div>
    </TooltipProvider>
  )
}
