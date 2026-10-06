import { Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { isSearchEnter } from '@/components/ui/search-enter'

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /**
   * `page` sits above a card list; `dense` belongs in a panel, sidebar or
   * toolbar. Anything between the two was previously improvised per screen —
   * magnifier icons ran from 11px to 16px and heights from h-7 to h-9.
   */
  size?: 'page' | 'dense'
  /**
   * Drops the border for a search that reads as part of its panel rather than
   * as a control sitting on it (sidebar filters).
   */
  borderless?: boolean
  className?: string
  autoFocus?: boolean
  /** Enter in the box (outside an IME composition). A dropdown's search uses it
   *  to pick its matches — see `search-enter.ts`. */
  onEnter?: () => void
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  size = 'page',
  borderless,
  className,
  autoFocus,
  onEnter,
}: SearchInputProps) {
  const { t } = useTranslation()
  const dense = size === 'dense'

  return (
    <div className={cn('relative', className)}>
      <Search
        size={dense ? 14 : 16}
        className={cn(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground',
          dense ? 'left-2' : 'left-3',
        )}
      />
      {/* A raw <input>, not <Input>: this needs icon padding on both sides and a
          borderless variant, which would mean overriding most of what <Input>
          sets. Feature code still goes through <Input> — the exemption is for
          this primitive, which is what feature code uses instead. */}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onEnter && ((e) => {
          if (!isSearchEnter(e)) return
          e.preventDefault()
          onEnter()
        })}
        placeholder={placeholder ?? t('common.search')}
        autoFocus={autoFocus}
        className={cn(
          'w-full rounded-md outline-none placeholder:text-muted-foreground',
          borderless
            ? 'border-0 bg-accent/50 shadow-none placeholder:text-muted-foreground/60'
            : 'border bg-transparent focus:border-primary',
          dense ? 'h-8 pl-7 pr-7 text-xs' : 'h-9 pl-9 pr-9 text-sm',
        )}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={t('common.clear')}
          className={cn(
            'absolute top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground',
            dense ? 'right-2' : 'right-3',
          )}
        >
          <X size={dense ? 12 : 14} />
        </button>
      )}
    </div>
  )
}
