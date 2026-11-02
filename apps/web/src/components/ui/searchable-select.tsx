import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Search, Star } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { firstMatchOnEnter, isSearchEnter } from '@/components/ui/search-enter'
import { SectionLabel } from '@/components/ui/section-label'

/** Same cap as MultiSelectFilter: past this, rendering every row is the dominant
 *  cost and the search box is how anything is reached anyway. */
const RENDER_CAP = 200

export interface SearchableSelectOption {
  value: string
  label: string
  /** Shown under the label — a description, a count, whatever disambiguates two
   *  options that read alike. */
  hint?: string
  /** The `groups` entry it is listed under. */
  group?: string
}

export interface SearchableSelectGroup {
  value: string
  label: string
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
  /** The selected option in the trigger; its label when absent. */
  renderValue?: (option: SearchableSelectOption) => ReactNode
  disabled?: boolean
  /** Headed sections, in this order; an option lists under its `group`. */
  groups?: SearchableSelectGroup[]
  /** Values listed first, under a Favorites heading. With `onToggleFavorite`,
   *  each row carries a star that adds it or takes it out. */
  favorites?: string[]
  onToggleFavorite?: (value: string) => void
}

interface Section {
  key: string
  label: string | null
  options: SearchableSelectOption[]
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
  renderValue,
  disabled,
  groups,
  favorites,
  onToggleFavorite,
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

  // A favourite moves to the top section rather than showing twice.
  const sections = useMemo((): Section[] => {
    const fav = new Set(favorites)
    const favOptions = visible.filter((o) => fav.has(o.value))
    const rest = visible.filter((o) => !fav.has(o.value))
    const out: Section[] = favOptions.length
      ? [{ key: '__favorites__', label: t('common.favorites'), options: favOptions }]
      : []
    if (!groups) {
      out.push({ key: '__all__', label: favOptions.length ? t('common.others') : null, options: rest })
    } else {
      for (const g of groups) out.push({ key: g.value, label: g.label, options: rest.filter((o) => o.group === g.value) })
      const known = new Set(groups.map((g) => g.value))
      out.push({ key: '__other__', label: null, options: rest.filter((o) => !o.group || !known.has(o.group)) })
    }
    return out.filter((sec) => sec.options.length > 0)
  }, [visible, groups, favorites, t])
  // Enter picks the first row as shown, favourites first.
  const shownOrder = useMemo(() => sections.flatMap((sec) => sec.options), [sections])

  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
    setSearch('')
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
            {selected ? (renderValue ? renderValue(selected) : selected.label) : placeholder}
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
              if (!isSearchEnter(e)) return
              e.preventDefault()
              const first = firstMatchOnEnter(search, shownOrder)
              if (first) pick(first.value)
            }}
            placeholder={searchPlaceholder ?? t('common.search')}
            className="h-7 w-full rounded border bg-transparent pl-7 pr-2 text-[11px] outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </div>
        <div
          className="min-h-0 flex-1 divide-y divide-border overflow-y-auto overscroll-contain rounded-md border"
          style={{ maxHeight: 'min(320px, var(--radix-popover-content-available-height, 320px))' }}
          // Opened from a dialog, the list is portaled outside it, where the
          // dialog's scroll lock swallows the wheel: scroll it by hand.
          onWheel={(e) => { e.stopPropagation(); e.currentTarget.scrollTop += e.deltaY }}
        >
          {sections.map((sec) => (
            <div key={sec.key} className="divide-y divide-border">
              {sec.label && <SectionLabel className="bg-muted/30 px-2 py-1">{sec.label}</SectionLabel>}
              {sec.options.map((opt) => {
                const isSelected = opt.value === value
                const isFavorite = !!favorites?.includes(opt.value)
                return (
                  <div
                    key={opt.value}
                    className={cn(
                      'group flex items-center transition-colors',
                      isSelected ? 'bg-accent/60 text-accent-foreground' : 'hover:bg-accent/30',
                    )}
                  >
                    <button
                      type="button"
                      title={opt.label}
                      onClick={() => pick(opt.value)}
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs"
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
                    {onToggleFavorite && (
                      <button
                        type="button"
                        onClick={() => onToggleFavorite(opt.value)}
                        aria-label={t(isFavorite ? 'common.remove_favorite' : 'common.add_favorite')}
                        title={t(isFavorite ? 'common.remove_favorite' : 'common.add_favorite')}
                        className={cn(
                          'mr-3 shrink-0 rounded p-1 text-muted-foreground hover:text-foreground',
                          !isFavorite && 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                        )}
                      >
                        <Star size={12} className={cn(isFavorite && 'fill-amber-400 text-amber-400')} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
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
