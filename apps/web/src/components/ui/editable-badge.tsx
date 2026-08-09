import { useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { getBadgeClasses, getBadgeStyle } from '@/lib/badge-colors'
import type { BadgeColor } from '@/types'

interface EditableBadgeProps {
  /** Already-resolved label (callers localize before passing). */
  label: string
  color: BadgeColor
  /** When omitted, the badge is read-only (no remove button). */
  onRemove?: () => void
  /** When provided, a pencil lets the user rename the badge (active language). */
  onRename?: (next: string) => void
}

/**
 * A colored badge chip (label + optional rename/remove controls). When editable,
 * the controls sit on the right edge. Renaming edits the label in the active
 * language via an inline input.
 */
export function EditableBadge({ label, color, onRemove, onRename }: EditableBadgeProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)

  const commit = () => {
    const next = draft.trim()
    if (next && next !== label) onRename?.(next)
    setEditing(false)
  }

  if (editing) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-xs font-medium ${getBadgeClasses(color)}`}
        style={getBadgeStyle(color)}
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            else if (e.key === 'Escape') { setDraft(label); setEditing(false) }
          }}
          onClick={(e) => e.stopPropagation()}
          className="w-24 bg-transparent outline-none placeholder:text-current/50"
        />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); commit() }}
          className="rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/20"
        >
          <Check size={12} />
        </button>
      </span>
    )
  }

  const hasControls = !!onRemove || !!onRename
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full py-0.5 text-xs font-medium ${hasControls ? 'pl-2.5 pr-1' : 'px-2.5'} ${getBadgeClasses(color)}`}
      style={getBadgeStyle(color)}
    >
      {label}
      {onRename && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setDraft(label); setEditing(true) }}
          className="rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/20"
          aria-label="Edit"
        >
          <Pencil size={11} />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          className="rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/20"
          aria-label="Remove"
        >
          <X size={12} />
        </button>
      )}
    </span>
  )
}
