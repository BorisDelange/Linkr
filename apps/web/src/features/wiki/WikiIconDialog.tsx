import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import * as LucideIcons from 'lucide-react'
import { Search, ExternalLink, Puzzle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

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

function fuzzyMatch(name: string, query: string): boolean {
  const lower = name.toLowerCase().replace(/([A-Z])/g, ' $1').toLowerCase()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.every((w) => lower.includes(w))
}

const PAGE_SIZE = 120

interface WikiIconDialogProps {
  pageId: string | null
  currentIcon?: string
  onClose: () => void
  onChange: (icon: string) => void
}

export function WikiIconDialog({ pageId, currentIcon, onClose, onChange }: WikiIconDialogProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const open = pageId !== null

  const filtered = useMemo(() => {
    if (!query.trim()) return ALL_ICON_NAMES
    return ALL_ICON_NAMES.filter((n) => fuzzyMatch(n, query))
  }, [query])

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])

  useEffect(() => {
    if (open) {
      setQuery('')
      setVisibleCount(PAGE_SIZE)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
    scrollRef.current?.scrollTo(0, 0)
  }, [query])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
      setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, filtered.length))
    }
  }, [filtered.length])

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-lg gap-0 p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-sm">{t('wiki.change_icon')}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('plugins.icon_search_placeholder')}
            className="h-7 border-0 p-0 text-xs shadow-none focus-visible:ring-0"
          />
        </div>

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

        <div ref={scrollRef} onScroll={handleScroll} className="max-h-64 overflow-auto px-2 pb-2">
          <div className="grid grid-cols-8 gap-0.5">
            {visible.map((name) => {
              const Ic = resolveIcon(name)
              const isSelected = name === currentIcon
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  onClick={() => onChange(name)}
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
      </DialogContent>
    </Dialog>
  )
}
