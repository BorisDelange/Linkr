import { useTranslation } from 'react-i18next'
import type { CriteriaConfig, SexCriteriaConfig, SchemaMapping } from '@/types'

interface SexCriteriaFormProps {
  config: CriteriaConfig
  onChange: (config: CriteriaConfig) => void
  genderValues?: SchemaMapping['genderValues']
}

const DEFAULT_GENDER_VALUES = { male: '8507', female: '8532', unknown: '0' }

export function SexCriteriaForm({ config, onChange, genderValues }: SexCriteriaFormProps) {
  const { t } = useTranslation()
  const c = config as SexCriteriaConfig
  const gv = genderValues ?? DEFAULT_GENDER_VALUES

  const options = [
    { value: gv.male, labelKey: 'cohorts.sex_male' },
    { value: gv.female, labelKey: 'cohorts.sex_female' },
    ...(gv.unknown ? [{ value: gv.unknown, labelKey: 'cohorts.sex_unknown' }] : []),
  ]

  const toggle = (value: string) => {
    const values = c.values.includes(value)
      ? c.values.filter((v) => v !== value)
      : [...c.values, value]
    onChange({ ...c, values })
  }

  return (
    <div className="flex gap-2">
      {options.map((opt) => {
        const selected = c.values.includes(opt.value)
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
