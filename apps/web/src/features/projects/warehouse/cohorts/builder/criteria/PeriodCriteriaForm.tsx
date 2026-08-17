import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDate } from '@/lib/format-helpers'
import type { PeriodCriteriaConfig } from '@/types'

interface PeriodCriteriaFormProps {
  config: PeriodCriteriaConfig
  onChange: (config: PeriodCriteriaConfig) => void
  visitDateRange?: { minDate: string; maxDate: string }
}

/** ISO `yyyy-mm-dd` from a Date, in local time — `toISOString()` would shift the
 *  day backwards for anyone west of UTC. */
function toIsoDay(date: Date): string {
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${m}-${d}`
}

/** Parse `yyyy-mm-dd` as a local date, for the same reason. */
function fromIsoDay(iso: string | undefined): Date | undefined {
  if (!iso) return undefined
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return undefined
  return new Date(y, m - 1, d)
}

function DateField({
  label,
  value,
  onChange,
  defaultMonth,
}: {
  label: string
  value?: string
  onChange: (value: string | undefined) => void
  defaultMonth?: Date
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const selected = fromIsoDay(value)

  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 flex-1 justify-start gap-1.5 px-2 text-xs font-normal"
            >
              <CalendarIcon size={12} className="shrink-0 opacity-60" />
              {selected ? (
                formatDate(value, i18n.language)
              ) : (
                <span className="text-muted-foreground">{t('cohorts.period_pick')}</span>
              )}
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
        {value && (
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
    </div>
  )
}

export function PeriodCriteriaForm({ config, onChange, visitDateRange }: PeriodCriteriaFormProps) {
  const { t } = useTranslation()
  // Open the calendar where the data actually is, not on today's month — these
  // databases are often years away from now.
  const fallbackMonth = fromIsoDay(visitDateRange?.minDate)

  return (
    <div className="grid grid-cols-2 gap-3">
      <DateField
        label={t('cohorts.period_start')}
        value={config.startDate}
        onChange={(startDate) => onChange({ ...config, startDate })}
        defaultMonth={fallbackMonth}
      />
      <DateField
        label={t('cohorts.period_end')}
        value={config.endDate}
        onChange={(endDate) => onChange({ ...config, endDate })}
        defaultMonth={fromIsoDay(config.startDate) ?? fallbackMonth}
      />
    </div>
  )
}
