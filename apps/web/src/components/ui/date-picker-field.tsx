import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarIcon, X } from 'lucide-react'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  dateMaskFor, digitsFromTyped, formatMasked, isoFromMasked, maskedFromIso,
} from '@/lib/date-mask'
import { cn } from '@/lib/utils'

/** ISO `YYYY-MM-DD` for a local date — NOT toISOString(), which shifts to UTC and
 *  can land on the previous day east of Greenwich. */
export function toIsoDay(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${m}-${d}`
}

/** Parse `YYYY-MM-DD` as a LOCAL date; `new Date(iso)` would read it as UTC. */
export function fromIsoDay(value?: string): Date | undefined {
  if (!value) return undefined
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return undefined
  return new Date(y, m - 1, d)
}

/** Read one edge out of a `{ before, after }` disabled matcher, ignoring the other
 *  shapes react-day-picker accepts (arrays, predicates, day-of-week matchers). */
function boundFrom(
  disabled: DatePickerFieldProps['disabledDays'],
  edge: 'before' | 'after',
): Date | undefined {
  if (!disabled || typeof disabled !== 'object' || Array.isArray(disabled)) return undefined
  const value = (disabled as Record<string, unknown>)[edge]
  return value instanceof Date ? value : undefined
}

interface DatePickerFieldProps {
  value?: string
  onChange: (value: string | undefined) => void
  /** Month shown when nothing is selected yet. */
  defaultMonth?: Date
  placeholder?: string
  /** Hide the clear button when the caller manages emptiness itself. */
  clearable?: boolean
  className?: string
  /** Days the calendar refuses, in react-day-picker's `disabled` shape — e.g.
   *  `{ before, after }` to confine the picker to a range the data covers. */
  disabledDays?: React.ComponentProps<typeof Calendar>['disabled']
  /** Also constrain the month dropdowns, so the caption can't navigate outside
   *  the allowed range either. Defaults to the bounds implied by `disabledDays`. */
  startMonth?: Date
  endMonth?: Date
}

/**
 * A date input built on the app's own Calendar, so every date field looks and
 * behaves the same. Not `<input type="date">`, whose picker is the browser's and
 * varies by platform and locale.
 *
 * Typed OR picked: the box takes the date directly — a date far from today costs
 * many clicks through a calendar, and one already known is faster typed — while the
 * icon still opens the calendar. Typing is GUIDED by a per-language mask
 * (`YYYY-MM-DD` in English, `JJ/MM/AAAA` in French): only digits are entered, the
 * separators appear on their own, and the shape is shown as the placeholder. That
 * removes the ambiguity a free-form date has — `01/04/2026` is two different days
 * to two readers, and no parser settles it.
 *
 * The value is an ISO day string, kept in LOCAL time throughout — the whole app
 * compares these against SQL dates, where a UTC shift would move the day.
 */
export function DatePickerField({
  value,
  onChange,
  defaultMonth,
  placeholder,
  clearable = true,
  className,
  disabledDays,
  startMonth,
  endMonth,
}: DatePickerFieldProps) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const selected = fromIsoDay(value)

  const mask = dateMaskFor(i18n.language)

  // The digits being typed, while they are being typed. Null means "not editing",
  // and the box shows the stored value laid out under the mask.
  const [draft, setDraft] = useState<string | null>(null)
  const digits = draft ?? maskedFromIso(value, mask)

  /**
   * Read the box after a keystroke.
   *
   * Deleting the auto-inserted separator has to delete the digit before it too:
   * the separator is derived from the digits, so removing it alone would put it
   * straight back and backspace would appear to be stuck at a group boundary.
   * Detected by the text getting SHORTER while its digits did not.
   */
  const type = (text: string) => {
    const before = formatMasked(digits, mask)
    const next = digitsFromTyped(text, mask)
    if (text.length < before.length && next === digits) {
      setDraft(digits.slice(0, -1))
      return
    }
    setDraft(next)
  }

  /**
   * Commit on the way out. An incomplete or impossible date is DISCARDED rather
   * than stored: the field's contract is a real ISO day, and until the eighth
   * digit lands there is nothing to store.
   */
  const commit = () => {
    if (draft === null) return
    const iso = isoFromMasked(draft, mask)
    setDraft(null)
    if (!draft) onChange(undefined)
    else if (iso && iso !== value) onChange(iso)
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-1', className)}>
      <div className="relative flex min-w-0 flex-1 items-center">
        <Input
          value={formatMasked(digits, mask)}
          // The format itself, so the shape is known before anything is typed.
          placeholder={placeholder ?? mask.placeholder}
          inputMode="numeric"
          onChange={(e) => type(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            else if (e.key === 'Escape') { e.preventDefault(); setDraft(null) }
          }}
          // An in-progress date that is not yet (or not) a real day is marked while
          // it is typed: it will be discarded on blur, and a field that silently
          // reverted would look like it had simply ignored the typing.
          className={cn(
            'h-7 min-w-0 flex-1 pr-7 font-mono text-xs',
            draft && !isoFromMasked(draft, mask) && 'text-destructive',
          )}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              // Out of the tab order: the field is fully typeable, so Tab should
              // move to the NEXT field rather than stopping on an icon that only
              // opens an alternative way to enter what was just typed.
              tabIndex={-1}
              className="absolute right-1 flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={t('common.select')}
            >
              <CalendarIcon size={12} />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={selected}
              defaultMonth={selected ?? defaultMonth}
              captionLayout="dropdown"
              disabled={disabledDays}
              // The year/month dropdowns span 1900..2100 by default, which would let
              // the caption wander far outside a bounded range.
              startMonth={startMonth ?? boundFrom(disabledDays, 'before')}
              endMonth={endMonth ?? boundFrom(disabledDays, 'after')}
              onSelect={(date) => {
                // Drop any half-typed text: the calendar is now the answer.
                setDraft(null)
                onChange(date ? toIsoDay(date) : undefined)
                setOpen(false)
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
      {clearable && value && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onChange(undefined)}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
          aria-label={t('common.clear')}
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}
