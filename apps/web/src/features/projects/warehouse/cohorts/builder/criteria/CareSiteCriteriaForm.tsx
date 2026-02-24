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
import type { CareSiteCriteriaConfig } from '@/types'

interface CareSiteCriteriaFormProps {
  config: CareSiteCriteriaConfig
  onChange: (config: CareSiteCriteriaConfig) => void
}

export function CareSiteCriteriaForm({ config, onChange }: CareSiteCriteriaFormProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.care_site_level')}</Label>
        <Select
          value={config.careSiteLevel}
          onValueChange={(v) => onChange({ ...config, careSiteLevel: v as 'visit' | 'visit_detail' })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="visit" className="text-xs">
              {t('cohorts.level_visit')}
            </SelectItem>
            <SelectItem value="visit_detail" className="text-xs">
              {t('cohorts.level_visit_detail')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t('cohorts.care_site_values')}</Label>
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
          placeholder={t('cohorts.care_site_hint')}
          className="h-8 text-xs"
        />
        <p className="text-[11px] text-muted-foreground">{t('cohorts.care_site_hint')}</p>
      </div>
    </div>
  )
}
