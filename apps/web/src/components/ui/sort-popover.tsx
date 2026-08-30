import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, ArrowUpDown, ArrowDownUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { SortField, SortState } from '@/components/ui/list-page-toolbar'

interface SortPopoverProps {
  options: SortField[]
  /** Active sort, or null for the caller's default order. */
  value: SortState | null
  onChange: (next: SortState | null) => void
  /** Tooltip and aria-label. Defaults to "Sort by". */
  label?: string
  className?: string
}

/**
 * The list-page sort control, for toolbars too small to carry a whole
 * `ListPageToolbar` — a widget's own header, say.
 *
 * Same popover, same asc → desc → off cycle and the same dimmed arrow on an
 * unsorted row, so sorting a widget's list reads exactly like sorting a page's.
 *
 * Carries its own TooltipProvider: a widget is not wrapped in one the way the
 * list pages are, and Radix throws without it. Nesting providers is harmless.
 */
export function SortPopover({ options, value, onChange, label, className }: SortPopoverProps) {
  const { t } = useTranslation()
  const title = label ?? t('common.sort_by')

  // One field at a time; clicking cycles asc → desc → off.
  const cycle = (key: string) => {
    if (value?.key !== key) onChange({ key, dir: 'asc' })
    else if (value.dir === 'asc') onChange({ key, dir: 'desc' })
    else onChange(null)
  }

  return (
    <TooltipProvider>
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant={value ? 'secondary' : 'ghost'}
              size="icon-xs"
              aria-label={title}
              className={cn('shrink-0', className)}
            >
              <ArrowDownUp size={12} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-48 p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="truncate text-[11px] font-medium text-muted-foreground">{title}</p>
          {value && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t('common.clear')}
            </button>
          )}
        </div>
        <div className="space-y-0.5">
          {options.map((field) => {
            const active = value?.key === field.key
            const dir = active ? value.dir : null
            return (
              <button
                key={field.key}
                type="button"
                onClick={() => cycle(field.key)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors',
                  active ? 'bg-accent/60' : 'hover:bg-accent/30',
                )}
              >
                {/* Unsorted shows a dimmed up/down pair rather than an empty slot:
                    it fills the gutter and advertises that the row sorts. */}
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  {dir === 'asc' ? (
                    <ArrowUp size={13} className="text-primary" strokeWidth={2.5} />
                  ) : dir === 'desc' ? (
                    <ArrowDown size={13} className="text-primary" strokeWidth={2.5} />
                  ) : (
                    <ArrowUpDown size={13} className="text-muted-foreground/40" strokeWidth={2} />
                  )}
                </span>
                <span className="truncate">{field.label}</span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
    </TooltipProvider>
  )
}
