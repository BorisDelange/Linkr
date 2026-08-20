import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
      {/* No placeholders on the bounds: a greyed "0"/"120" reads as an entered
          value, and an unset bound means "no limit", not zero. */}
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">{t('cohorts.age_min')}</Label>
          <Input
            type="number"
            value={config.min ?? ''}
            onChange={(e) =>
              onChange({ ...config, min: e.target.value ? Number(e.target.value) : undefined })
            }
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
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('cohorts.age_unit')}</Label>
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
        </div>
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
