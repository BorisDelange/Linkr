import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CriteriaConfig, PeriodCriteriaConfig } from '@/types'

interface PeriodCriteriaFormProps {
  config: CriteriaConfig
  onChange: (config: CriteriaConfig) => void
}

export function PeriodCriteriaForm({ config, onChange }: PeriodCriteriaFormProps) {
  const { t } = useTranslation()
  const c = config as PeriodCriteriaConfig

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.period_start')}</Label>
        <Input
          type="date"
          value={c.startDate ?? ''}
          onChange={(e) => onChange({ ...c, startDate: e.target.value || undefined })}
          className="h-8 text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.period_end')}</Label>
        <Input
          type="date"
          value={c.endDate ?? ''}
          onChange={(e) => onChange({ ...c, endDate: e.target.value || undefined })}
          className="h-8 text-xs"
        />
      </div>
    </div>
  )
}
