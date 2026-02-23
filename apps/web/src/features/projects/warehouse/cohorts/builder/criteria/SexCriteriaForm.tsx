import { useTranslation } from 'react-i18next'
import type { SexCriteriaConfig } from '@/types'

interface SexCriteriaFormProps {
  config: SexCriteriaConfig
  onChange: (config: SexCriteriaConfig) => void
  genderValues?: { male: string; female: string; unknown?: string }
}

const DEFAULT_GENDER_VALUES = { male: '8507', female: '8532', unknown: '0' }

export function SexCriteriaForm({ config, onChange, genderValues }: SexCriteriaFormProps) {
  const { t } = useTranslation()
  const gv = genderValues ?? DEFAULT_GENDER_VALUES

  const options = [
    { value: gv.male, labelKey: 'cohorts.sex_male' },
    { value: gv.female, labelKey: 'cohorts.sex_female' },
    ...(gv.unknown ? [{ value: gv.unknown, labelKey: 'cohorts.sex_unknown' }] : []),
  ]

  const toggle = (value: string) => {
    const values = config.values.includes(value)
      ? config.values.filter((v) => v !== value)
      : [...config.values, value]
    onChange({ ...config, values })
  }

  return (
    <div className="flex gap-2">
      {options.map((opt) => {
        const selected = config.values.includes(opt.value)
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => toggle(opt.value)}
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
