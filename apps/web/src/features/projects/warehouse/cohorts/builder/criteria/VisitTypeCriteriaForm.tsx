import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { VisitTypeCriteriaConfig } from '@/types'

interface VisitTypeCriteriaFormProps {
  config: VisitTypeCriteriaConfig
  onChange: (config: VisitTypeCriteriaConfig) => void
}

export function VisitTypeCriteriaForm({ config, onChange }: VisitTypeCriteriaFormProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-1">
      <Label className="text-xs">{t('cohorts.visit_type_values')}</Label>
      <Input
        type="text"
        value={config.values.join(', ')}
        onChange={(e) => {
          const values = e.target.value
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v.length > 0)
          onChange({ ...config, values })
        }}
        placeholder={t('cohorts.visit_type_hint')}
        className="h-8 text-xs"
      />
      <p className="text-[11px] text-muted-foreground">{t('cohorts.visit_type_hint')}</p>
    </div>
  )
}
