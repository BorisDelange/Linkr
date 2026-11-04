import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface DebouncedInputProps {
  value: string
  /** With `commitOnEnter`, may answer false to refuse the value: the field
   *  then goes back to `value`. */
  onChange: (v: string) => void | boolean | Promise<void | boolean>
  /** Debounce delay in ms (default 300). */
  delay?: number
  /**
   * Commit only on Enter (Escape reverts), for a filter whose query is too
   * heavy to rerun as the user types — a fuzzy search over a whole vocabulary.
   */
  commitOnEnter?: boolean
  className?: string
  placeholder?: string
  title?: string
}

/**
 * Text input that debounces `onChange` (default 300ms) so a fast-changing filter
 * doesn't fire a query on every keystroke. The field stays fully responsive
 * locally; only the committed value is debounced. Syncs when `value` changes
 * externally (e.g. a filter reset).
 */
export function DebouncedInput({ value, onChange, delay = 300, commitOnEnter, className, placeholder, title }: DebouncedInputProps) {
  const { t } = useTranslation()
  const [local, setLocal] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => { setLocal(value) }, [value])
  useEffect(() => () => clearTimeout(timer.current), [])

  const commit = async () => {
    const v = local.trim()
    if (v === value) return
    if ((await onChange(v)) === false) setLocal(value)
  }

  const input = (
    <input
      className={cn(className, commitOnEnter && 'pr-6')}
      placeholder={placeholder}
      title={title ?? (commitOnEnter ? t('common.filter_on_enter_hint') : undefined)}
      value={local}
      onChange={(e) => {
        const v = e.target.value
        setLocal(v)
        if (commitOnEnter) return
        clearTimeout(timer.current)
        timer.current = setTimeout(() => onChange(v), delay)
      }}
      onKeyDown={commitOnEnter ? (e) => {
        if (e.key === 'Enter') { e.preventDefault(); void commit() }
        else if (e.key === 'Escape' && local !== value) { e.preventDefault(); e.stopPropagation(); setLocal(value) }
      } : undefined}
    />
  )
  if (!commitOnEnter) return input
  // The key that runs the search stays visible at the right, whatever is typed:
  // a filter that does nothing until Enter must say so.
  return (
    <div className="relative w-full">
      {input}
      <kbd aria-hidden className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 rounded border bg-muted px-1 font-sans text-[10px] leading-tight text-muted-foreground">
        ↵
      </kbd>
    </div>
  )
}
