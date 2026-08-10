import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * What a file explorer is ordered by.
 *
 * `manual` is the user's own drag order, which some trees persist (the SQL
 * scripts tree, where the sequence is the point). It is offered as a column so
 * choosing a sort is reversible — otherwise sorting once would lose an
 * arrangement that cannot be reconstructed.
 */
export type FileTreeSortKey = 'name' | 'size' | 'manual'

export interface FileTreeSort {
  key: FileTreeSortKey
  desc: boolean
}

interface Props {
  sort: FileTreeSort
  onChange: (sort: FileTreeSort) => void
  /** Hide the size column where no size is known (a tree of folders only). */
  showSize?: boolean
  /** Offer the user's drag order as a column, for trees that persist one. */
  showManual?: boolean
  className?: string
}

/**
 * Column header for a file explorer sidebar: sort by name or by size.
 *
 * Shared so the four file trees (IDE, ETL scripts, SQL scripts, datasets) order
 * themselves the same way and read the same — they were written separately and
 * had drifted apart.
 *
 * Clicking the active column flips the direction; clicking the other switches to
 * it. Name starts ascending (A→Z is what a file list is expected to do) and size
 * descending (the big files are the interesting ones).
 */
export function FileTreeHeader({ sort, onChange, showSize = true, showManual = false, className }: Props) {
  const { t } = useTranslation()

  const select = (key: FileTreeSortKey) => {
    onChange(sort.key === key ? { key, desc: !sort.desc } : { key, desc: key === 'size' })
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b px-2 py-1 text-[10px] text-muted-foreground',
        className,
      )}
    >
      <SortButton
        label={t('files.column_name')}
        active={sort.key === 'name'}
        desc={sort.desc}
        onClick={() => select('name')}
        className="min-w-0 flex-1"
      />
      {showSize && (
        <SortButton
          label={t('files.column_size')}
          active={sort.key === 'size'}
          desc={sort.desc}
          onClick={() => select('size')}
          className="shrink-0"
        />
      )}
      {showManual && (
        <SortButton
          label={t('files.column_manual')}
          active={sort.key === 'manual'}
          desc={sort.desc}
          onClick={() => select('manual')}
          className="shrink-0"
        />
      )}
    </div>
  )
}

function SortButton({
  label,
  active,
  desc,
  onClick,
  className,
}: {
  label: string
  active: boolean
  desc: boolean
  onClick: () => void
  className?: string
}) {
  const Icon = !active ? ArrowUpDown : desc ? ArrowDown : ArrowUp
  return (
    <button
      type="button"
      onClick={onClick}
      aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}
      className={cn(
        'flex items-center gap-1 truncate rounded px-1 py-0.5 transition-colors hover:bg-accent/50 hover:text-foreground',
        active && 'font-medium text-foreground',
        className,
      )}
    >
      <span className="truncate">{label}</span>
      <Icon size={10} className={cn('shrink-0', !active && 'opacity-40')} />
    </button>
  )
}
