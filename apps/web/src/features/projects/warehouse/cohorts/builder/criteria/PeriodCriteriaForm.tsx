import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { PeriodCriteriaConfig } from '@/types'

interface PeriodCriteriaFormProps {
  config: PeriodCriteriaConfig
  onChange: (config: PeriodCriteriaConfig) => void
}

export function PeriodCriteriaForm({ config, onChange }: PeriodCriteriaFormProps) {
  const { t } = useTranslation()

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.period_start')}</Label>
        <Input
          type="date"
          value={config.startDate ?? ''}
          onChange={(e) => onChange({ ...config, startDate: e.target.value || undefined })}
          className="h-8 text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.period_end')}</Label>
        <Input
          type="date"
          value={config.endDate ?? ''}
          onChange={(e) => onChange({ ...config, endDate: e.target.value || undefined })}
          className="h-8 text-xs"
        />
      </div>
    </div>
  )
}
