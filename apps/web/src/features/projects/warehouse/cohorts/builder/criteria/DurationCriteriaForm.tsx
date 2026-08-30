import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/ui/form-field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { DurationCriteriaConfig, DurationUnit } from '@/types'

interface DurationCriteriaFormProps {
  config: DurationCriteriaConfig
  onChange: (config: DurationCriteriaConfig) => void
}

export function DurationCriteriaForm({ config, onChange }: DurationCriteriaFormProps) {
  const { t } = useTranslation()
  const unit: DurationUnit = config.durationUnit ?? 'days'

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t('cohorts.duration_level')}>
          {() => (
          <Select
            value={config.durationLevel ?? 'visit'}
            onValueChange={(v) => onChange({ ...config, durationLevel: v as 'visit' | 'visit_detail' })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="visit" className="text-xs">
                {t('cohorts.duration_visit')}
              </SelectItem>
              <SelectItem value="visit_detail" className="text-xs">
                {t('cohorts.duration_visit_detail')}
              </SelectItem>
            </SelectContent>
          </Select>
          )}
        </FormField>
        <FormField label={t('cohorts.duration_unit')}>
          {() => (
          <Select
            value={unit}
            onValueChange={(v) => onChange({ ...config, durationUnit: v as DurationUnit })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hours" className="text-xs">
                {t('cohorts.duration_hours')}
              </SelectItem>
              <SelectItem value="days" className="text-xs">
                {t('cohorts.duration_days')}
              </SelectItem>
              <SelectItem value="months" className="text-xs">
                {t('cohorts.duration_months')}
              </SelectItem>
            </SelectContent>
          </Select>
          )}
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t('cohorts.duration_min', { unit: t(`cohorts.duration_${unit}`) })}>
          {({ id }) => (
          <Input
            id={id}
            type="number"
            value={config.minDays ?? ''}
            onChange={(e) =>
              onChange({ ...config, minDays: e.target.value ? Number(e.target.value) : undefined })
            }
            className="h-8 text-xs"
          />
          )}
        </FormField>
        <FormField label={t('cohorts.duration_max', { unit: t(`cohorts.duration_${unit}`) })}>
          {({ id }) => (
          <Input
            id={id}
            type="number"
            value={config.maxDays ?? ''}
            onChange={(e) =>
              onChange({ ...config, maxDays: e.target.value ? Number(e.target.value) : undefined })
            }
            className="h-8 text-xs"
          />
          )}
        </FormField>
      </div>
    </div>
  )
}
