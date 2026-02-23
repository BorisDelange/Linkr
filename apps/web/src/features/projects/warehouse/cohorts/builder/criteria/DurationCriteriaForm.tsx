import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { DurationCriteriaConfig } from '@/types'

interface DurationCriteriaFormProps {
  config: DurationCriteriaConfig
  onChange: (config: DurationCriteriaConfig) => void
}

export function DurationCriteriaForm({ config, onChange }: DurationCriteriaFormProps) {
  const { t } = useTranslation()

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.duration_min')}</Label>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            value={config.minDays ?? ''}
            onChange={(e) =>
              onChange({ ...config, minDays: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="0"
            className="h-8 text-xs"
          />
          <span className="text-xs text-muted-foreground shrink-0">{t('cohorts.duration_days')}</span>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.duration_max')}</Label>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            value={config.maxDays ?? ''}
            onChange={(e) =>
              onChange({ ...config, maxDays: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="365"
            className="h-8 text-xs"
          />
          <span className="text-xs text-muted-foreground shrink-0">{t('cohorts.duration_days')}</span>
        </div>
      </div>
    </div>
  )
}
