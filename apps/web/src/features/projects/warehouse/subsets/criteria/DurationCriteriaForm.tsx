import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CriteriaConfig, DurationCriteriaConfig } from '@/types'

interface DurationCriteriaFormProps {
  config: CriteriaConfig
  onChange: (config: CriteriaConfig) => void
}

export function DurationCriteriaForm({ config, onChange }: DurationCriteriaFormProps) {
  const { t } = useTranslation()
  const c = config as DurationCriteriaConfig

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label className="text-xs">{t('subsets.duration_min')}</Label>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            value={c.minDays ?? ''}
            onChange={(e) =>
              onChange({ ...c, minDays: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="0"
            className="h-8 text-xs"
          />
          <span className="text-xs text-muted-foreground shrink-0">{t('subsets.duration_days')}</span>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t('subsets.duration_max')}</Label>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            value={c.maxDays ?? ''}
            onChange={(e) =>
              onChange({ ...c, maxDays: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="365"
            className="h-8 text-xs"
          />
          <span className="text-xs text-muted-foreground shrink-0">{t('subsets.duration_days')}</span>
        </div>
      </div>
    </div>
  )
}
