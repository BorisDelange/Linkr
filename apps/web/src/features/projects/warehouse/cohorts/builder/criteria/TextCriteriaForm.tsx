import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { TextCriteriaConfig } from '@/types'

interface TextCriteriaFormProps {
  config: TextCriteriaConfig
  onChange: (config: TextCriteriaConfig) => void
}

export function TextCriteriaForm({ config, onChange }: TextCriteriaFormProps) {
  const { t } = useTranslation()
  const description = config?.description ?? ''

  return (
    <div className="space-y-1">
      <Label className="text-xs">{t('cohorts.text_description')}</Label>
      <Textarea
        value={description}
        onChange={(e) => onChange({ ...config, description: e.target.value })}
        rows={2}
        className="text-xs resize-none"
      />
    </div>
  )
}
