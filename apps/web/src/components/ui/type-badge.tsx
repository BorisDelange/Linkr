import { cn } from '@/lib/utils'

/** Small colored badge for a SQL/data column type — shared by every schema view. */

export const TYPE_CONFIG: Record<string, { icon: string; color: string }> = {
  number:  { icon: '#',  color: 'bg-blue-500/15 text-blue-700 dark:text-blue-400' },
  string:  { icon: 'Aa', color: 'bg-green-500/15 text-green-700 dark:text-green-400' },
  boolean: { icon: '⊘',  color: 'bg-purple-500/15 text-purple-700 dark:text-purple-400' },
  date:    { icon: '◷',  color: 'bg-orange-500/15 text-orange-700 dark:text-orange-400' },
  unknown: { icon: '?',  color: 'bg-gray-500/15 text-gray-700 dark:text-gray-400' },
}

/** Map a raw SQL/DuckDB type name to one of the badge categories. */
export function mapColumnType(dtype: string): string {
  const d = dtype.toLowerCase()
  if (d.includes('int') || d.includes('float') || d.includes('double') || d.includes('decimal') || d.includes('numeric') || d.includes('real')) return 'number'
  if (d.includes('bool')) return 'boolean'
  if (d.includes('date') || d.includes('time') || d.includes('timestamp')) return 'date'
  if (d.includes('char') || d.includes('text') || d.includes('string') || d.includes('varchar') || d.includes('blob')) return 'string'
  return 'unknown'
}

export function TypeBadge({ type }: { type: string }) {
  const config = TYPE_CONFIG[mapColumnType(type)] ?? TYPE_CONFIG.unknown
  return (
    <span
      className={cn(
        // Fixed width, centred: the glyphs differ in width ('Aa' vs '#'), which
        // shifted every column name in a schema listing out of alignment.
        'inline-flex w-5 shrink-0 items-center justify-center rounded py-0.5 font-mono text-[9px] font-semibold leading-none',
        config.color,
      )}
    >
      {config.icon}
    </span>
  )
}
