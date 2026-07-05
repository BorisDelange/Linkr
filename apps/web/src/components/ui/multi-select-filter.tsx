import { useState, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Search } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** Cap the number of option rows rendered at once. With very large option sets
 *  (e.g. ~3700 categories) rendering every row is the dominant cost; users reach
 *  any value via the search box. Small lists (the common case) never hit this. */
const RENDER_CAP = 200

/** Generic option shape. */
export type MultiSelectOption = string | { value: string; label: string }

interface MultiSelectFilterProps {
  /** Currently selected values. Empty array = no filter (matches everything). */
  value: string[]
  /** Available options. */
  options: MultiSelectOption[]
  /** Placeholder shown in the trigger when nothing is selected. */
  placeholder: string
  /** Called when the selection changes. */
  onChange: (next: string[]) => void
  /** Width of the popover (default: w-56). */
  popoverWidthClass?: string
  /** Trigger button class — defaults to a small dashed-border filter look. */
  triggerClass?: string
  /** When true, clicking "Select all" toggles all currently *visible* (filtered) options on/off. */
  selectAllRespectsSearch?: boolean
  /** Optional custom renderer for an option's content (e.g. a type badge before the label).
   *  When omitted, the label text is shown. */
  renderOption?: (option: { value: string; label: string }) => ReactNode
}

/**
 * Compact multi-select dropdown for inline column filters.
 *
 * Pattern shared with `MultiColumnSelect` (analyses GenericConfigPanel):
 * - Search input at the top
 * - "Select all" / "Select none" buttons
 * - Checkbox rows below
 *
 * Empty `value` → no filter applied.
 */
export function MultiSelectFilter({
  value,
  options,
  placeholder,
  onChange,
  popoverWidthClass = 'w-56',
  triggerClass,
  selectAllRespectsSearch = true,
  renderOption,
}: MultiSelectFilterProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const normalized = useMemo(
    () => options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)),
    [options],
  )

  const searchFiltered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return normalized
    return normalized.filter((o) => o.label.toLowerCase().includes(q))
  }, [normalized, search])

  const visible = searchFiltered.length > RENDER_CAP ? searchFiltered.slice(0, RENDER_CAP) : searchFiltered
  const hiddenCount = searchFiltered.length - visible.length

  const valueSet = useMemo(() => new Set(value), [value])
  const isActive = value.length > 0

  const triggerLabel = (() => {
    if (value.length === 0) return placeholder
    if (value.length === 1) return normalized.find((o) => o.value === value[0])?.label ?? value[0]
    return t('common.n_selected', { count: value.length, defaultValue: '{{count}} selected' })
  })()

  const toggle = (val: string) => {
    if (valueSet.has(val)) onChange(value.filter((v) => v !== val))
    else onChange([...value, val])
  }

  const selectAll = () => {
    const pool = selectAllRespectsSearch ? searchFiltered : normalized
    const merged = new Set(value)
    for (const o of pool) merged.add(o.value)
    onChange([...merged])
  }

  const selectNone = () => onChange([])

  const defaultTriggerClass = 'h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary'

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch('') }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            triggerClass ?? defaultTriggerClass,
            'flex items-center truncate',
            isActive && 'border-primary text-foreground',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="truncate">{triggerLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className={cn(popoverWidthClass, 'p-2 bg-popover flex flex-col overflow-hidden')}
        style={{ maxHeight: 'var(--radix-popover-content-available-height, 420px)' }}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative mb-2">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              // Enter selects every filtered option (not just the rendered slice).
              if (e.key === 'Enter') { e.preventDefault(); selectAll(); setOpen(false) }
            }}
            placeholder={t('common.search')}
            className="h-7 w-full rounded border bg-transparent pl-7 pr-2 text-[11px] outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={selectAll}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              {t('common.select_all')}
            </button>
            <span className="text-[10px] text-muted-foreground">/</span>
            <button
              type="button"
              onClick={selectNone}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              {t('common.select_none')}
            </button>
          </div>
          <span className="text-[10px] text-muted-foreground">
            {value.length}/{normalized.length}
          </span>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md border divide-y divide-border bg-popover"
          style={{ maxHeight: 'min(420px, var(--radix-popover-content-available-height, 420px))' }}
          onWheel={(e) => { e.stopPropagation(); e.currentTarget.scrollTop += e.deltaY }}
        >
          {visible.map((opt) => {
            const isSelected = valueSet.has(opt.value)
            return (
              <button
                key={opt.value}
                type="button"
                title={opt.label}
                onClick={() => toggle(opt.value)}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1.5 text-xs transition-colors text-left',
                  isSelected ? 'bg-accent/60 text-accent-foreground' : 'hover:bg-accent/30',
                )}
              >
                <div
                  className={cn(
                    'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                    isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30',
                  )}
                >
                  {isSelected && <Check size={10} />}
                </div>
                {renderOption ? renderOption(opt) : <span className="truncate">{opt.label}</span>}
              </button>
            )
          })}
          {searchFiltered.length === 0 && (
            <p className="py-2 text-center text-[10px] text-muted-foreground">{t('common.no_results')}</p>
          )}
          {hiddenCount > 0 && (
            <p className="py-1.5 text-center text-[10px] text-muted-foreground">
              {t('common.refine_search', { shown: visible.length, total: searchFiltered.length, defaultValue: 'Showing {{shown}} of {{total}} — refine your search' })}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
