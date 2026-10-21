import { cn } from '@/lib/utils'

/**
 * The look of a tab in an editor's tab bar (IDE, datasets, ETL, SQL scripts,
 * plugin editor), whatever it holds — a script, a terminal or an output. White
 * at rest, tinted on hover, and the open one underlined in the primary colour.
 */
export function editorTabClass(active: boolean): string {
  return cn(
    'relative group flex shrink-0 items-center gap-1.5 whitespace-nowrap border-r px-3 py-1.5 text-xs transition-colors',
    active
      ? 'bg-background text-foreground shadow-[inset_0_-2px_0_var(--color-primary)]'
      : 'bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
  )
}
