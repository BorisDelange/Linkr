import { useState, type ComponentProps } from 'react'
import { Input } from '@/components/ui/input'

interface NumberInputProps extends Omit<ComponentProps<typeof Input>, 'type' | 'value' | 'onChange' | 'min' | 'max' | 'step'> {
  value: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** Whole numbers only. */
  integer?: boolean
}

/**
 * A number field that always holds a number, yet can be emptied while typing.
 *
 * A plain `<input type="number">` bound to a number cannot be cleared: the
 * handler turns '' into a fallback and writes it straight back, so the "1"
 * never goes away. Here the text being typed lives apart from the value; each
 * keystroke that reads as a number in range is sent, and leaving the field
 * shows the value again — clamped when what was typed fell outside the range.
 */
export function NumberInput({ value, onValueChange, min, max, step, integer = true, onBlur, ...props }: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const parse = (text: string): number | null => {
    if (text.trim() === '') return null
    const n = integer ? parseInt(text, 10) : Number(text)
    return Number.isFinite(n) ? n : null
  }
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
  return (
    <Input
      {...props}
      type="number"
      inputMode={integer ? 'numeric' : 'decimal'}
      min={min}
      max={max}
      step={step ?? (integer ? 1 : 'any')}
      value={draft ?? String(value)}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = parse(e.target.value)
        if (n != null && n === clamp(n) && n !== value) onValueChange(n)
      }}
      onBlur={(e) => {
        const n = draft == null ? null : parse(draft)
        if (n != null && clamp(n) !== value) onValueChange(clamp(n))
        setDraft(null)
        onBlur?.(e)
      }}
    />
  )
}
