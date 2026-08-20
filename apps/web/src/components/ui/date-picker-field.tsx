import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDate } from '@/lib/format-helpers'
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

interface DatePickerFieldProps {
  value?: string
  onChange: (value: string | undefined) => void
  /** Month shown when nothing is selected yet. */
  defaultMonth?: Date
  placeholder?: string
  /** Hide the clear button when the caller manages emptiness itself. */
  clearable?: boolean
  className?: string
}

/**
 * A date input built on the app's own Calendar, so every date field looks and
 * behaves the same. Uses `<Button>` + `<Popover>` rather than `<input type="date">`,
 * whose picker is the browser's and varies by platform and locale.
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
}: DatePickerFieldProps) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const selected = fromIsoDay(value)

  return (
    <div className={cn('flex min-w-0 items-center gap-1', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm-tight"
            className="min-w-0 flex-1 justify-start .5 px-2 font-normal"
          >
            <CalendarIcon size={12} className="shrink-0 opacity-60" />
            <span className="truncate">
              {selected ? (
                formatDate(value, i18n.language)
              ) : (
                <span className="text-muted-foreground">
                  {placeholder ?? t('common.select')}
                </span>
              )}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected ?? defaultMonth}
            captionLayout="dropdown"
            onSelect={(date) => {
              onChange(date ? toIsoDay(date) : undefined)
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      {clearable && value && (
        <button
          type="button"
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
