import { useTranslation } from 'react-i18next'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AlertTriangle } from 'lucide-react'
import { ageCriterionUnsatisfiable } from '@/lib/duckdb/cohort-query'
import type { AgeCriteriaConfig, AgeUnit, SchemaMapping } from '@/types'

interface AgeCriteriaFormProps {
  config: AgeCriteriaConfig
  onChange: (config: AgeCriteriaConfig) => void
  schemaMapping?: SchemaMapping
}

export function AgeCriteriaForm({ config, onChange, schemaMapping }: AgeCriteriaFormProps) {
  const { t } = useTranslation()

  // Days/months need a birth date; a mapping with only a birth year cannot
  // answer them and would quietly return an empty cohort.
  const unsatisfiable = schemaMapping ? ageCriterionUnsatisfiable(config, schemaMapping) : false

  const referenceOptions: { value: AgeCriteriaConfig['ageReference']; labelKey: string }[] = [
    { value: 'admission', labelKey: 'cohorts.age_admission' },
    { value: 'current', labelKey: 'cohorts.age_current' },
  ]

  return (
    <div className="space-y-3">
      <FormField label={t('cohorts.age_reference')}>
        {() => (
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
        )}
      </FormField>
      {/* No placeholders on the bounds: a greyed "0"/"120" reads as an entered
          value, and an unset bound means "no limit", not zero. */}
      <div className="grid grid-cols-3 gap-3">
        <FormField label={t('cohorts.age_min')}>
          {({ id }) => (
          <Input
            id={id}
            type="number"
            value={config.min ?? ''}
            onChange={(e) =>
              onChange({ ...config, min: e.target.value ? Number(e.target.value) : undefined })
            }
            className="h-8 text-xs"
          />
          )}
        </FormField>
        <FormField label={t('cohorts.age_max')}>
          {({ id }) => (
          <Input
            id={id}
            type="number"
            value={config.max ?? ''}
            onChange={(e) =>
              onChange({ ...config, max: e.target.value ? Number(e.target.value) : undefined })
            }
            className="h-8 text-xs"
          />
          )}
        </FormField>
        <FormField label={t('cohorts.age_unit')}>
          {() => (
          <Select
            value={config.ageUnit ?? 'years'}
            onValueChange={(v) => onChange({ ...config, ageUnit: v as AgeUnit })}
          >
            <SelectTrigger size="sm" className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['years', 'months', 'days'] as AgeUnit[]).map((u) => (
                <SelectItem key={u} value={u} className="text-xs">
                  {t(`cohorts.age_unit_${u}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          )}
        </FormField>
      </div>
      {unsatisfiable && (
        <p className="flex items-start gap-1.5 text-[10px] text-amber-600 dark:text-amber-500">
          <AlertTriangle size={12} className="mt-px shrink-0" />
          {t('cohorts.age_needs_birth_date')}
        </p>
      )}
    </div>
  )
}
