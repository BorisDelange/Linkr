import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AgeCriteriaConfig } from '@/types'

interface AgeCriteriaFormProps {
  config: AgeCriteriaConfig
  onChange: (config: AgeCriteriaConfig) => void
}

export function AgeCriteriaForm({ config, onChange }: AgeCriteriaFormProps) {
  const { t } = useTranslation()

  const referenceOptions: { value: AgeCriteriaConfig['ageReference']; labelKey: string }[] = [
    { value: 'admission', labelKey: 'cohorts.age_admission' },
    { value: 'current', labelKey: 'cohorts.age_current' },
  ]

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.age_reference')}</Label>
        <div className="flex gap-2">
          {referenceOptions.map((opt) => {
            const selected = config.ageReference === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange({ ...config, ageReference: opt.value })}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                  selected
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted/50'
                }`}
              >
                {t(opt.labelKey)}
              </button>
            )
          })}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">{t('cohorts.age_min')}</Label>
          <Input
            type="number"
            value={config.min ?? ''}
            onChange={(e) =>
              onChange({ ...config, min: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="0"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('cohorts.age_max')}</Label>
          <Input
            type="number"
            value={config.max ?? ''}
            onChange={(e) =>
              onChange({ ...config, max: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="120"
            className="h-8 text-xs"
          />
        </div>
      </div>
    </div>
  )
}
