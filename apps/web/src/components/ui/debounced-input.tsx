import { useEffect, useRef, useState } from 'react'

interface DebouncedInputProps {
  value: string
  onChange: (v: string) => void
  /** Debounce delay in ms (default 300). */
  delay?: number
  className?: string
  placeholder?: string
}

/**
 * Text input that debounces `onChange` (default 300ms) so a fast-changing filter
 * doesn't fire a query on every keystroke. The field stays fully responsive
 * locally; only the committed value is debounced. Syncs when `value` changes
 * externally (e.g. a filter reset).
 */
export function DebouncedInput({ value, onChange, delay = 300, className, placeholder }: DebouncedInputProps) {
  const [local, setLocal] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => { setLocal(value) }, [value])
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <input
      className={className}
      placeholder={placeholder}
      value={local}
      onChange={(e) => {
        const v = e.target.value
        setLocal(v)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => onChange(v), delay)
      }}
    />
  )
}
