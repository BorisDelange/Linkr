import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Search, SlidersHorizontal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterOption {
  value: string
  label: string
  /** Optional colored dot rendered before the label (e.g. a status colour). */
  dotClass?: string
  /** Optional badge-style classes rendered around the label (custom badges). */
  badgeClass?: string
  /** Inline style for custom-hex badge colours. */
  badgeStyle?: React.CSSProperties
}

export interface FilterGroup {
  key: string
  label: string
  options: FilterOption[]
  /** Currently selected values in this group. */
  selected: string[]
  onChange: (next: string[]) => void
}

interface ListPageToolbarProps {
  searchQuery: string
  onSearchChange: (value: string) => void
  searchPlaceholder?: string
  /** Filter groups. When empty/omitted, no Filters button is shown. */
  filterGroups?: FilterGroup[]
  /** Extra content rendered on the right of the row (rarely needed). */
  children?: ReactNode
  className?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Shared list-page toolbar: a Filters button (only when there are filterable
 * dimensions) on the left, followed by a full-width search input. Rendered on
 * its own row below the page title so every list page reads the same way.
 */
export function ListPageToolbar({
  searchQuery,
  onSearchChange,
  searchPlaceholder,
  filterGroups,
  children,
  className,
}: ListPageToolbarProps) {
  const { t } = useTranslation()
  const groups = filterGroups?.filter((g) => g.options.length > 0) ?? []
  const activeCount = groups.reduce((sum, g) => sum + g.selected.length, 0)

  const toggle = (group: FilterGroup, value: string) => {
    if (group.selected.includes(value)) group.onChange(group.selected.filter((v) => v !== value))
    else group.onChange([...group.selected, value])
  }

  const clearAll = () => groups.forEach((g) => g.selected.length && g.onChange([]))

  return (
    <div className={cn('mt-4 flex items-center gap-2', className)}>
      {groups.length > 0 && (
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant={activeCount > 0 ? 'default' : 'outline'}
                  size="sm"
                  aria-label={t('common.filters')}
                  className="h-9 shrink-0 gap-1.5 px-2.5"
                >
                  <SlidersHorizontal size={16} />
                  {activeCount > 0 && (
                    <Badge variant="secondary" className="text-[9px] leading-none">{activeCount}</Badge>
                  )}
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{t('common.filters')}</TooltipContent>
          </Tooltip>
          <PopoverContent align="start" className="w-64 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium">{t('common.filters')}</span>
              {activeCount > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {t('common.clear')}
                </button>
              )}
            </div>
            <div className="max-h-80 space-y-3 overflow-y-auto">
              {groups.map((group) => (
                <div key={group.key}>
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">{group.label}</p>
                  <div className="space-y-0.5">
                    {group.options.map((opt) => {
                      const checked = group.selected.includes(opt.value)
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => toggle(group, opt.value)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors',
                            checked ? 'bg-accent/60' : 'hover:bg-accent/30',
                          )}
                        >
                          <span
                            className={cn(
                              'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                              checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30',
                            )}
                          >
                            {checked && <Check size={10} strokeWidth={3} />}
                          </span>
                          {opt.dotClass && <span className={cn('size-1.5 shrink-0 rounded-full', opt.dotClass)} />}
                          {opt.badgeClass !== undefined ? (
                            <span
                              className={cn('truncate rounded px-1.5 py-0.5 text-[10px] font-medium', opt.badgeClass)}
                              style={opt.badgeStyle}
                            >
                              {opt.label}
                            </span>
                          ) : (
                            <span className="truncate">{opt.label}</span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}

      <div className="relative flex-1">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder ?? t('common.search')}
          className="h-9 w-full rounded-md border bg-transparent pl-9 pr-9 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label={t('common.clear')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {children}
    </div>
  )
}
