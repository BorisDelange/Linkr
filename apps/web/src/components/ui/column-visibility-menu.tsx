import { useState, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** One toggleable column. `id` is generic so callers can key by string id or numeric index. */
export interface ColumnVisibilityItem<Id> {
  id: Id
  /** Plain-text label, used for searching and the hover tooltip. */
  label: string
  /** Optional rich content (e.g. a type badge before the label); falls back to `label`. */
  content?: ReactNode
  visible: boolean
}

interface ColumnVisibilityMenuProps<Id> {
  items: ColumnVisibilityItem<Id>[]
  onToggle: (id: Id, visible: boolean) => void
  /** Bulk set visibility for the given ids (e.g. the search-filtered subset). */
  onSetMany: (ids: Id[], visible: boolean) => void
  /** Optional override for the trigger button (defaults to a gear icon). */
  trigger?: ReactNode
  align?: 'start' | 'center' | 'end'
}

/**
 * Shared column-visibility dropdown: gear trigger, search box, "Select all / None",
 * a hover tooltip revealing each full label, and a checkbox per column.
 *
 * Generic over the id type so it works with string column ids or numeric indices.
 */
export function ColumnVisibilityMenu<Id extends string | number>({
  items,
  onToggle,
  onSetMany,
  trigger,
  align = 'start',
}: ColumnVisibilityMenuProps<Id>) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')

  const matched = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? items.filter((c) => c.label.toLowerCase().includes(q)) : items
  }, [items, search])

  return (
    <DropdownMenu onOpenChange={(open) => { if (!open) setSearch('') }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            {trigger ?? (
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <Settings2 size={12} />
              </Button>
            )}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">{t('common.columns')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align={align}
        className="max-h-[340px] w-[220px] overflow-y-auto"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuLabel className="flex items-center justify-between gap-2 text-xs">
          <span>{t('files.columns', 'Columns')}</span>
          <span className="flex items-center gap-1 font-normal">
            <button
              onClick={(e) => { e.preventDefault(); onSetMany(matched.map((c) => c.id), true) }}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('common.select_all')}
            </button>
            <span className="text-muted-foreground">/</span>
            <button
              onClick={(e) => { e.preventDefault(); onSetMany(matched.map((c) => c.id), false) }}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('common.select_none')}
            </button>
          </span>
        </DropdownMenuLabel>
        <div className="px-1 pb-1">
          <div className="relative">
            <Search size={11} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={t('common.search')}
              className="h-6 w-full rounded border bg-transparent pl-6 pr-1.5 text-[11px] outline-none placeholder:text-muted-foreground focus:border-primary"
            />
          </div>
        </div>
        <DropdownMenuSeparator />
        {matched.length === 0 ? (
          <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">{t('common.no_results')}</div>
        ) : (
          <TooltipProvider delayDuration={400}>
            {matched.map((col) => (
              <Tooltip key={String(col.id)}>
                <TooltipTrigger asChild>
                  <DropdownMenuCheckboxItem
                    checked={col.visible}
                    onCheckedChange={(checked) => onToggle(col.id, !!checked)}
                    onSelect={(e) => e.preventDefault()}
                    className="text-xs"
                  >
                    {col.content ?? <span className="truncate">{col.label}</span>}
                  </DropdownMenuCheckboxItem>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-64">{col.label}</TooltipContent>
              </Tooltip>
            ))}
          </TooltipProvider>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
