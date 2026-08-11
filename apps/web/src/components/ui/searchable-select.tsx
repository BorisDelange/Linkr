import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Search } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** Same cap as MultiSelectFilter: past this, rendering every row is the dominant
 *  cost and the search box is how anything is reached anyway. */
const RENDER_CAP = 200

export interface SearchableSelectOption {
  value: string
  label: string
  /** Shown under the label — a description, a count, whatever disambiguates two
   *  options that read alike. */
  hint?: string
}

interface Props {
  /** Selected value; empty string means nothing is selected. */
  value: string
  options: SearchableSelectOption[]
  /** Shown in the trigger when nothing is selected. */
  placeholder: string
  onChange: (value: string) => void
  /** Search box placeholder — defaults to the shared `common.search`. */
  searchPlaceholder?: string
  triggerClass?: string
  popoverWidthClass?: string
  renderOption?: (option: SearchableSelectOption) => ReactNode
  disabled?: boolean
}

/**
 * A single-select dropdown with a search box.
 *
 * Not built on Radix's Select: that component owns keyboard input inside its
 * content (type-ahead jumps to the matching option), so a text field placed in
 * it never receives what the user types. The Popover + button-list combination
 * is the same one MultiSelectFilter uses, so the two read alike.
 */
export function SearchableSelect({
  value,
  options,
  placeholder,
  onChange,
  searchPlaceholder,
  triggerClass,
  popoverWidthClass,
  renderOption,
  disabled,
}: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) =>
      o.label.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q))
  }, [options, search])

  const visible = filtered.length > RENDER_CAP ? filtered.slice(0, RENDER_CAP) : filtered
  const hiddenCount = filtered.length - visible.length
  const selected = options.find((o) => o.value === value)

  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        // Cleared on close, so reopening does not present a list still narrowed
        // by a search the user has forgotten making.
        if (!o) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md border bg-transparent px-3 text-xs outline-none',
            'focus:border-primary disabled:cursor-not-allowed disabled:opacity-50',
            triggerClass,
          )}
        >
          <span className={cn('min-w-0 flex-1 truncate text-left', !selected && 'text-muted-foreground')}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronDown size={14} className="shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        // Matches the trigger, so the open list lines up with the closed control
        // instead of being an arbitrary width.
        className={cn('flex flex-col overflow-hidden p-2', popoverWidthClass ?? 'w-[var(--radix-popover-trigger-width)]')}
        style={{ maxHeight: 'var(--radix-popover-content-available-height, 420px)' }}
        onOpenAutoFocus={(e) => {
          // Focus the search box, not the first option: typing is the point.
          e.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <div className="relative mb-2">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // Enter takes the only remaining match — with one left, making the
              // user reach for it is a pointless extra step.
              if (e.key === 'Enter' && filtered.length === 1) {
                e.preventDefault()
                pick(filtered[0].value)
              }
            }}
            placeholder={searchPlaceholder ?? t('common.search')}
            className="h-7 w-full rounded border bg-transparent pl-7 pr-2 text-[11px] outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </div>
        <div
          className="min-h-0 flex-1 divide-y divide-border overflow-y-auto overscroll-contain rounded-md border"
          style={{ maxHeight: 'min(320px, var(--radix-popover-content-available-height, 320px))' }}
        >
          {visible.map((opt) => {
            const isSelected = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                title={opt.label}
                onClick={() => pick(opt.value)}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors',
                  isSelected ? 'bg-accent/60 text-accent-foreground' : 'hover:bg-accent/30',
                )}
              >
                <Check size={12} className={cn('shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} />
                {renderOption
                  ? renderOption(opt)
                  : (
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{opt.label}</span>
                        {opt.hint && (
                          <span className="block truncate text-[10px] text-muted-foreground">{opt.hint}</span>
                        )}
                      </span>
                    )}
              </button>
            )
          })}
          {filtered.length === 0 && (
            <p className="py-2 text-center text-[10px] text-muted-foreground">{t('common.no_results')}</p>
          )}
          {hiddenCount > 0 && (
            <p className="py-1.5 text-center text-[10px] text-muted-foreground">
              {t('common.refine_search', {
                shown: visible.length,
                total: filtered.length,
                defaultValue: 'Showing {{shown}} of {{total}} — refine your search',
              })}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
