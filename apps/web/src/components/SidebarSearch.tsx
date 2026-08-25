import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Toggle + field state for a sidebar search, so every file sidebar behaves the
 * same way. Closing clears the query: leaving a filter applied behind a hidden
 * field would silently hide entries with no visible reason why.
 */
export function useSidebarSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      if (wasOpen) setQuery('')
      return !wasOpen
    })
  }, [])

  return { open, query, setQuery, toggle }
}

/** Filters by case-insensitive substring, the same test every sidebar uses. */
export function matchesSidebarSearch(text: string, query: string) {
  const q = query.trim().toLowerCase()
  return !q || text.toLowerCase().includes(q)
}

/**
 * Ids to keep when searching a file tree: every node whose name matches, plus
 * the folders on its path — a match three folders deep is unreachable if its
 * ancestors are filtered away. Returns null when the query is empty, so callers
 * can skip filtering entirely and leave the tree untouched.
 *
 * The kept ancestors double as the folders to force open while searching, since
 * a result inside a collapsed folder is a result the user cannot see.
 */
export function treeSearchMatches<T extends { id: string; name: string; parentId: string | null }>(
  nodes: T[],
  query: string,
): Set<string> | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const keep = new Set<string>()
  for (const node of nodes) {
    if (!node.name.toLowerCase().includes(q)) continue
    keep.add(node.id)
    let parentId = node.parentId
    while (parentId && !keep.has(parentId)) {
      keep.add(parentId)
      parentId = byId.get(parentId)?.parentId ?? null
    }
  }
  return keep
}

/**
 * The magnifier that reveals the search field, sitting in a sidebar's header
 * beside its create/upload actions.
 */
export function SidebarSearchToggle({
  open,
  onToggle,
  label,
}: {
  open: boolean
  onToggle: () => void
  label: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onToggle}
          // Kept at the hover shade while open, so the toggle reads as ON
          // even when the pointer is elsewhere.
          className={cn(open && 'bg-accent text-accent-foreground')}
          aria-pressed={open}
          aria-label={label}
        >
          <Search size={14} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The search field itself, mounted under the header while open. `onStep` is
 * optional: sidebars that have a selection let the arrows walk it without
 * leaving the field.
 */
export function SidebarSearchField({
  value,
  onChange,
  onClose,
  onStep,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  onClose: () => void
  onStep?: (delta: number) => void
  placeholder: string
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => { ref.current?.focus() }, [])

  return (
    <div className="border-b p-1.5">
      <div className="relative">
        <Input
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="h-6 pr-6 text-xs"
          onKeyDown={(e) => {
            e.stopPropagation()
            if (onStep && e.key === 'ArrowDown') { e.preventDefault(); onStep(1) }
            else if (onStep && e.key === 'ArrowUp') { e.preventDefault(); onStep(-1) }
            else if (e.key === 'Escape') { e.preventDefault(); onClose() }
          }}
        />
        {/* Closes the search outright rather than only emptying it — the same
            action as clicking the magnifier again, which is what a user reaching
            for this cross expects. */}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
