import { X } from 'lucide-react'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import type { BadgeColor } from '@/types'

interface EditableBadgeProps {
  label: string
  color: BadgeColor
  /** When omitted, the badge is read-only (no remove button). */
  onRemove?: () => void
}

/**
 * A colored badge chip (label + optional trailing X), as used in the badge
 * editors of the project/workspace settings and create dialogs. When removable,
 * the X is pushed to the right edge (label grows left, button hugs the right).
 */
export function EditableBadge({ label, color, onRemove }: EditableBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full py-0.5 text-xs font-medium ${onRemove ? 'pl-2.5 pr-1' : 'px-2.5'} ${getBadgeClasses(color)}`}
      style={getBadgeStyle(color)}
    >
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/20"
        >
          <X size={12} />
        </button>
      )}
    </span>
  )
}
