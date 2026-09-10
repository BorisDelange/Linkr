import type { Matcher } from 'react-day-picker'
import { DatePickerField, fromIsoDay, toIsoDay } from '@/components/ui/date-picker-field'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * A date field that optionally also takes a time of day.
 *
 * Wraps `DatePickerField` rather than replacing it, so a plain date still gets the
 * app's own calendar popover and every date control keeps behaving the same. The
 * time half is a separate `<input type="time">`: a calendar cannot express minutes,
 * and pairing the two keeps each control doing the thing it is good at.
 *
 * The value is `YYYY-MM-DD` without time and `YYYY-MM-DDTHH:MM[:SS]` with it, kept
 * in LOCAL time throughout — the same contract as DatePickerField, since these are
 * compared against SQL timestamps where a UTC shift would move the day.
 */
interface DateTimeFieldProps {
  value?: string
  onChange: (value: string | undefined) => void
  /** Show the time half. A date and a datetime are different questions: "when did
   *  the stay start" wants a day, "when was the drug given" wants a minute. */
  withTime?: boolean
  disabled?: boolean
  className?: string
  /** Inclusive ISO bounds, passed through to the calendar. */
  min?: string
  max?: string
}

export function DateTimeField({
  value, onChange, withTime = false, disabled, className, min, max,
}: DateTimeFieldProps) {
  const [day = '', time = ''] = (value ?? '').split('T')

  const emit = (nextDay: string | undefined, nextTime: string) => {
    if (!nextDay) return onChange(undefined)
    // A time with no date is not a moment, so the day is what decides whether
    // anything is emitted at all.
    onChange(withTime && nextTime ? `${nextDay}T${nextTime}` : nextDay)
  }

  // One matcher per bound rather than a single `{before, after}` interval: that
  // shape is `DateInterval`, which requires BOTH ends, so a column with only a
  // minimum could not be expressed. Separate matchers also read as "disable days
  // before min" OR "after max", which is what a one-sided bound means — an interval
  // with a missing end would disable nothing.
  const before = fromIsoDay(min?.split('T')[0])
  const after = fromIsoDay(max?.split('T')[0])
  const bounds: Matcher[] = []
  if (before) bounds.push({ before })
  if (after) bounds.push({ after })

  return (
    <div className={cn('flex min-w-0 items-center gap-1', className)}>
      {/* `flex-1` either way: with no time half the date should still fill the
          field rather than sit at its natural width beside empty space. */}
      <DatePickerField
        value={day || undefined}
        onChange={(d) => emit(d, time)}
        className="flex-1"
        disabledDays={bounds.length ? bounds : undefined}
      />
      {withTime && (
        <Input
          type="time"
          step={1}
          value={time}
          disabled={disabled}
          onChange={(e) => emit(day || toIsoDay(new Date()), e.target.value)}
          className="h-7 w-[7.5rem] shrink-0 text-xs"
        />
      )}
    </div>
  )
}
