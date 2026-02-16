import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CriteriaConfig, AgeCriteriaConfig } from '@/types'

interface AgeCriteriaFormProps {
  config: CriteriaConfig
  onChange: (config: CriteriaConfig) => void
}

export function AgeCriteriaForm({ config, onChange }: AgeCriteriaFormProps) {
  const { t } = useTranslation()
  const c = config as AgeCriteriaConfig

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.age_min')}</Label>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            value={c.min ?? ''}
            onChange={(e) =>
              onChange({ ...c, min: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="0"
            className="h-8 text-xs"
          />
          <span className="text-xs text-muted-foreground shrink-0">{t('cohorts.age_years')}</span>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.age_max')}</Label>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            value={c.max ?? ''}
            onChange={(e) =>
              onChange({ ...c, max: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="120"
            className="h-8 text-xs"
          />
          <span className="text-xs text-muted-foreground shrink-0">{t('cohorts.age_years')}</span>
        </div>
      </div>
    </div>
  )
}
