import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { DatePickerField, fromIsoDay } from '@/components/ui/date-picker-field'
import type { PeriodCriteriaConfig } from '@/types'

/** Label + shared date picker, so cohort periods use the same field as everywhere else. */
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
  const { t } = useTranslation()
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <DatePickerField
        value={value}
        onChange={onChange}
        defaultMonth={defaultMonth}
        placeholder={t('cohorts.period_pick')}
      />
    </div>
  )
}

interface PeriodCriteriaFormProps {
  config: PeriodCriteriaConfig
  onChange: (config: PeriodCriteriaConfig) => void
  visitDateRange?: { minDate: string; maxDate: string }
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
