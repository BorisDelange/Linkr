import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface Props {
  values: string[]
  selected: string[]
  onChange: (selected: string[]) => void
  placeholder: string
  disabled?: boolean
  /** Below this many options the search box is noise. */
  searchThreshold?: number
  className?: string
}

/**
 * Multi-select with search and select-all/none, matching the pattern used by the
 * plugin config panel so the bench controls feel like the rest of the app.
 */
export function BenchMultiSelect({
  values,
  selected,
  onChange,
  placeholder,
  disabled,
  searchThreshold = 5,
  className,
}: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return values
    return values.filter((value) => value.toLowerCase().includes(query))
  }, [values, search])

  const label =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? selected[0]
        : `${selected.length} / ${values.length}`

  const toggle = (value: string) =>
    onChange(
      selected.includes(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value]
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-8 items-center justify-between rounded-md border px-3 text-xs transition-colors hover:bg-accent/50 disabled:opacity-50',
            className
          )}
        >
          <span className={cn('truncate', !selected.length && 'text-muted-foreground')}>
            {label}
          </span>
          <ChevronsUpDown size={12} className="ml-1 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-56 bg-popover p-2"
        align="start"
        side="bottom"
        avoidCollisions={false}
      >
        {values.length > searchThreshold ? (
          <div className="relative mb-2">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('common.search')}
              className="h-7 pl-7 text-xs"
            />
          </div>
        ) : null}

        <div className="mb-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => onChange(values)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            {t('common.select_all')}
          </button>
          <span className="text-[10px] text-muted-foreground">/</span>
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            {t('common.select_none')}
          </button>
        </div>

        <div
          className="max-h-[200px] divide-y divide-border overflow-y-auto overscroll-contain rounded-md border bg-popover"
          onWheel={(e) => {
            e.stopPropagation()
            e.currentTarget.scrollTop += e.deltaY
          }}
        >
          {visible.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t('common.no_results')}
            </p>
          ) : null}
          {visible.map((value) => {
            const isSelected = selected.includes(value)
            return (
              <button
                key={value}
                type="button"
                onClick={() => toggle(value)}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors',
                  isSelected ? 'bg-accent/60 text-accent-foreground' : 'hover:bg-accent/30'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{value}</span>
                {isSelected ? <Check size={12} className="shrink-0" /> : null}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
