import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The dashed "choose a file" area, shared by every file-source field.
 *
 * Its height is FIXED rather than driven by content: these zones sit side by
 * side across the add-database dialogs (upload a file, upload a folder, pick a
 * server path), and one carrying an extra hint line used to render taller than
 * its neighbours — the box visibly resized when the user switched engine or
 * origin. A fixed height keeps the dialog still.
 */
export function FileDropZone({
  icon,
  label,
  hint,
  onClick,
  className,
}: {
  icon: ReactNode
  label: string
  /** Optional second line (e.g. the accepted extensions). Its presence must not
   *  change the box height, so the slot is reserved either way. */
  hint?: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-28 w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-muted-foreground/25 bg-muted/30 px-4 transition-colors hover:border-muted-foreground/40 hover:bg-muted/50',
        className,
      )}
    >
      {icon}
      <p className="text-xs text-muted-foreground">{label}</p>
      {/* Rendered even when empty: the reserved line is what keeps every zone
          the same height whether or not it has a hint. */}
      <p className="min-h-4 text-[10px] text-muted-foreground/60">{hint ?? ''}</p>
    </button>
  )
}
