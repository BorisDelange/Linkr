import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { DeathCriteriaConfig } from '@/types'

interface DeathCriteriaFormProps {
  config: DeathCriteriaConfig
  onChange: (config: DeathCriteriaConfig) => void
}

export function DeathCriteriaForm({ config, onChange }: DeathCriteriaFormProps) {
  const { t } = useTranslation()

  const statusOptions: { value: boolean; labelKey: string }[] = [
    { value: true, labelKey: 'cohorts.death_deceased' },
    { value: false, labelKey: 'cohorts.death_alive' },
  ]

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {statusOptions.map((opt) => {
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
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.death_reference')}</Label>
        <Select
          value={config.deathReference ?? 'visit'}
          onValueChange={(v) => onChange({ ...config, deathReference: v as 'visit' | 'visit_detail' })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="visit" className="text-xs">
              {t('cohorts.death_visit')}
            </SelectItem>
            <SelectItem value="visit_detail" className="text-xs">
              {t('cohorts.death_visit_detail')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
