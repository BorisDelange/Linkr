import { useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const MAX_SHOWN = 50

interface SuggestInputProps {
  value: string
  /** Called on blur, Enter or a picked suggestion — never per keystroke. */
  onCommit: (value: string) => void
  suggestions: readonly string[]
  placeholder?: string
  className?: string
  id?: string
}

/**
 * A free-text field with a compact suggestion list: the value may be anything
 * (a column the DDL never listed), the list only helps. Replaces the browser's
 * `<datalist>`, whose popup ignores the app's type scale and spacing.
 *
 * Typing filters the list (substring, any case); ↑/↓ move, Enter picks,
 * Escape closes. The text is kept locally and committed on blur or Enter,
 * like `DraftInput`.
 */
export function SuggestInput({ value, onCommit, suggestions, placeholder, className, id }: SuggestInputProps) {
  const [draft, setDraft] = useState(value)
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setDraft(value)
  }
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [typed, setTyped] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Until the user types, show everything: the current value is not a filter.
  const shown = useMemo(() => {
    const q = typed ? draft.trim().toLowerCase() : ''
    const hits = q ? suggestions.filter((s) => s.toLowerCase().includes(q)) : suggestions
    return hits.slice(0, MAX_SHOWN)
  }, [suggestions, draft, typed])

  const commit = (v: string) => {
    setOpen(false)
    setTyped(false)
    setActive(-1)
    setDraft(v)
    if (v !== value) onCommit(v)
  }

  return (
    <Popover open={open && shown.length > 0} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          ref={inputRef}
          id={id}
          value={draft}
          placeholder={placeholder}
          autoComplete="off"
          className={cn('h-7 font-mono text-xs', className)}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setDraft(e.target.value)
            setTyped(true)
            setActive(-1)
            setOpen(true)
          }}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              setActive((i) => Math.min(shown.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(-1, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              commit(active >= 0 ? shown[active] : draft)
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={2}
        // Focus stays in the field: the list is navigated from the keyboard there.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // The field is the anchor, outside the list: a click in it would read as
        // a click away and close the list the focus just opened.
        onInteractOutside={(e) => {
          if (e.target instanceof Node && inputRef.current?.contains(e.target)) e.preventDefault()
        }}
        className="max-h-56 w-[var(--radix-popover-trigger-width)] min-w-40 overflow-auto p-1"
      >
        {shown.map((s, i) => (
          <div
            key={s}
            role="option"
            aria-selected={i === active}
            // mousedown, not click: a click lands after the input's blur.
            onMouseDown={(e) => {
              e.preventDefault()
              commit(s)
            }}
            onMouseEnter={() => setActive(i)}
            className={cn(
              'cursor-pointer truncate rounded-sm px-2 py-1 font-mono text-xs',
              i === active ? 'bg-accent text-accent-foreground' : s === value ? 'text-foreground' : 'text-foreground/80',
            )}
          >
            {s}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}
