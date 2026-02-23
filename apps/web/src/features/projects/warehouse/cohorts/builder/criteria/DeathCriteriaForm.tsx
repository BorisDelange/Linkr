import { useTranslation } from 'react-i18next'
import type { DeathCriteriaConfig } from '@/types'

interface DeathCriteriaFormProps {
  config: DeathCriteriaConfig
  onChange: (config: DeathCriteriaConfig) => void
}

export function DeathCriteriaForm({ config, onChange }: DeathCriteriaFormProps) {
  const { t } = useTranslation()

  const options: { value: boolean; labelKey: string }[] = [
    { value: true, labelKey: 'cohorts.death_deceased' },
    { value: false, labelKey: 'cohorts.death_alive' },
  ]

  return (
    <div className="flex gap-2">
      {options.map((opt) => {
        const selected = config.isDead === opt.value
        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange({ ...config, isDead: opt.value })}
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
  )
}
