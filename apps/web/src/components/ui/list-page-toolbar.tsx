import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Check, Search, SlidersHorizontal, X, type LucideIcon } from 'lucide-react'
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
  /** Optional icon rendered before the label, replacing the dot (e.g. an entity type). */
  icon?: LucideIcon
  /** Tailwind text-colour class for `icon`. */
  iconClass?: string
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

export type SortDir = 'asc' | 'desc'

export interface SortState {
  key: string
  dir: SortDir
}

export interface SortField {
  key: string
  label: string
}

export interface SortConfig {
  options: SortField[]
  /** Active sort, or null when sorting is off (page default order). */
  value: SortState | null
  onChange: (next: SortState | null) => void
}

interface ListPageToolbarProps {
  searchQuery: string
  onSearchChange: (value: string) => void
  searchPlaceholder?: string
  /** Filter groups. When empty/omitted, no Filters button is shown. */
  filterGroups?: FilterGroup[]
  /** Sort fields. When omitted, no Sort section is shown in the popover. */
  sort?: SortConfig
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
  sort,
  children,
  className,
}: ListPageToolbarProps) {
  const { t } = useTranslation()
  const groups = filterGroups?.filter((g) => g.options.length > 0) ?? []
  const sortFields = sort?.options ?? []
  const hasPopover = groups.length > 0 || sortFields.length > 0
  const activeCount = groups.reduce((sum, g) => sum + g.selected.length, 0) + (sort?.value ? 1 : 0)

  const toggle = (group: FilterGroup, value: string) => {
    if (group.selected.includes(value)) group.onChange(group.selected.filter((v) => v !== value))
    else group.onChange([...group.selected, value])
  }

  // One field active at a time; clicking cycles asc → desc → off.
  const cycleSort = (key: string) => {
    if (!sort) return
    if (sort.value?.key !== key) sort.onChange({ key, dir: 'asc' })
    else if (sort.value.dir === 'asc') sort.onChange({ key, dir: 'desc' })
    else sort.onChange(null)
  }

  const clearAll = () => {
    groups.forEach((g) => g.selected.length && g.onChange([]))
    if (sort?.value) sort.onChange(null)
  }

  return (
    <div className={cn('mt-4 flex items-center gap-2', className)}>
      {hasPopover && (
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
            {/* Clear sits on the right of the first section's header row so it
                never adds a row of its own. */}
            {(() => {
              const clear = activeCount > 0 ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {t('common.clear')}
                </button>
              ) : null
              const sectionHeader = (label: string, first: boolean) => (
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="truncate text-[11px] font-medium text-muted-foreground">{label}</p>
                  {first && clear}
                </div>
              )
              return (
            <div className="max-h-80 space-y-3 overflow-y-auto">
              {sortFields.length > 0 && (
                <div>
                  {sectionHeader(t('common.sort_by'), true)}
                  <div className="space-y-0.5">
                    {sortFields.map((field) => {
                      const active = sort?.value?.key === field.key
                      const dir = active ? sort!.value!.dir : null
                      return (
                        <button
                          key={field.key}
                          type="button"
                          onClick={() => cycleSort(field.key)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors',
                            active ? 'bg-accent/60' : 'hover:bg-accent/30',
                          )}
                        >
                          <span className="flex size-3.5 shrink-0 items-center justify-center">
                            {dir === 'asc' && <ArrowUp size={13} className="text-primary" strokeWidth={2.5} />}
                            {dir === 'desc' && <ArrowDown size={13} className="text-primary" strokeWidth={2.5} />}
                          </span>
                          <span className="truncate">{field.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {groups.map((group, gi) => (
                <div key={group.key}>
                  {sectionHeader(group.label, sortFields.length === 0 && gi === 0)}
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
                          {opt.icon && <opt.icon size={13} className={cn('shrink-0', opt.iconClass)} />}
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
              )
            })()}
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
