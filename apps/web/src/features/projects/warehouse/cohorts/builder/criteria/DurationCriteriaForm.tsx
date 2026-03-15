import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
        <div className="space-y-1">
          <Label className="text-xs">{t('cohorts.duration_level')}</Label>
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
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('cohorts.duration_unit')}</Label>
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
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">
            {unit === 'hours' ? t('cohorts.duration_min_hours') : t('cohorts.duration_min_days')}
          </Label>
          <Input
            type="number"
            value={config.minDays ?? ''}
            onChange={(e) =>
              onChange({ ...config, minDays: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="0"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">
            {unit === 'hours' ? t('cohorts.duration_max_hours') : t('cohorts.duration_max_days')}
          </Label>
          <Input
            type="number"
            value={config.maxDays ?? ''}
            onChange={(e) =>
              onChange({ ...config, maxDays: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder={unit === 'hours' ? '720' : '365'}
            className="h-8 text-xs"
          />
        </div>
      </div>
    </div>
  )
}
