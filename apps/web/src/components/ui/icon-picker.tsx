import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import * as LucideIcons from 'lucide-react'
import { Search, ExternalLink, Puzzle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** All valid lucide-react icon names (computed once). */
const ALL_ICON_NAMES: string[] = (() => {
  const skip = new Set(['default', 'icons', 'createLucideIcon', 'createElement', 'IconNode'])
  return Object.keys(LucideIcons).filter(
    (k) => k[0] === k[0].toUpperCase() && typeof (LucideIcons as Record<string, unknown>)[k] === 'object' && !skip.has(k),
  ).sort()
})()

const TOTAL_ICONS = ALL_ICON_NAMES.length

function resolveIcon(name: string): LucideIcons.LucideIcon {
  const icon = (LucideIcons as Record<string, unknown>)[name]
  if (typeof icon === 'object' && icon !== null) return icon as LucideIcons.LucideIcon
  return Puzzle
}

/** Simple fuzzy search: splits query into words and checks if all words are found as substrings. */
function fuzzyMatch(name: string, query: string): boolean {
  const lower = name.toLowerCase().replace(/([A-Z])/g, ' $1').toLowerCase()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.every((w) => lower.includes(w))
}

const PAGE_SIZE = 120

interface IconPickerProps {
  value: string
  onChange: (name: string) => void
  iconColor?: string
  disabled?: boolean
  /** Hide the text label next to the icon (default: true) */
  showLabel?: boolean
  /** Set to false when used inside a Dialog to avoid focus-trap scroll conflicts (default: true) */
  modal?: boolean
}

export function IconPicker({ value, onChange, iconColor, disabled, showLabel = true, modal = true }: IconPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(value), 150)
  }, [])

  const filtered = useMemo(() => {
    if (!debouncedQuery.trim()) return ALL_ICON_NAMES
    return ALL_ICON_NAMES.filter((n) => fuzzyMatch(n, debouncedQuery))
  }, [debouncedQuery])

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('')
      setDebouncedQuery('')
      setVisibleCount(PAGE_SIZE)
      // Focus search input after popover renders
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    return () => clearTimeout(debounceRef.current)
  }, [open])

  // Reset visible count on debounced query change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
    scrollRef.current?.scrollTo(0, 0)
  }, [debouncedQuery])

  // Infinite scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
      setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, filtered.length))
    }
  }, [filtered.length])

  const Icon = resolveIcon(value)
  const colorStyle: React.CSSProperties | undefined = iconColor ? { color: iconColor } : undefined

  return (
    <Popover open={open} onOpenChange={setOpen} modal={modal}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        >
          <Icon size={16} style={colorStyle} className={!iconColor ? 'text-muted-foreground' : undefined} />
          {showLabel && <span className="truncate max-w-[100px]">{value || 'Puzzle'}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        {/* Search */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder={t('plugins.icon_search_placeholder')}
            className="h-7 border-0 p-0 text-xs shadow-none focus-visible:ring-0"
          />
        </div>
        {/* Count + link */}
        <div className="flex items-center justify-between px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>
            {filtered.length === TOTAL_ICONS
              ? t('plugins.icon_total', { count: TOTAL_ICONS })
              : t('plugins.icon_filtered', { shown: filtered.length, total: TOTAL_ICONS })}
          </span>
          <a
            href="https://lucide.dev/icons/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-primary hover:underline"
          >
            lucide.dev <ExternalLink size={9} />
          </a>
        </div>
        {/* Grid */}
        <div ref={scrollRef} onScroll={handleScroll} className="max-h-64 overflow-auto px-2 pb-2">
          <div className="grid grid-cols-8 gap-0.5">
            {visible.map((name) => {
              const Ic = resolveIcon(name)
              const isSelected = name === value
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  onClick={() => { onChange(name); setOpen(false) }}
                  className={cn(
                    'flex items-center justify-center rounded-md p-1.5 transition-colors',
                    isSelected
                      ? 'bg-primary/10 ring-1 ring-primary'
                      : 'hover:bg-accent',
                  )}
                >
                  <Ic size={16} />
                </button>
              )
            })}
          </div>
          {visible.length === 0 && (
            <p className="py-4 text-center text-xs text-muted-foreground">{t('plugins.icon_no_results')}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
