import { Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

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
  className?: string
  autoFocus?: boolean
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  size = 'page',
  className,
  autoFocus,
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
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t('common.search')}
        autoFocus={autoFocus}
        className={cn(
          'w-full rounded-md border bg-transparent outline-none placeholder:text-muted-foreground focus:border-primary',
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
