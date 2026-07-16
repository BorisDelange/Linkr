import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'

// OMOP validity is driven by invalid_reason: NULL = valid, 'U' = upgraded (a newer
// concept supersedes it), 'D' = deleted. Abbreviated single-letter badge, mirroring
// StandardConceptBadge — 'V' green for valid, the raw reason letter otherwise.
const INVALID_LABEL_KEYS: Record<string, string> = {
  U: 'concept_mapping.validity_upgraded',
  D: 'concept_mapping.validity_deleted',
}

export function ValidityBadge({ value }: { value: string | null | undefined }) {
  const { t } = useTranslation()
  const isValid = !value
  const badge = isValid ? (
    <Badge variant="default" className="bg-green-600 px-1 py-0.5 text-[8px] leading-none text-white border-transparent hover:bg-green-600">
      V
    </Badge>
  ) : (
    <Badge variant="outline" className="px-1 py-0.5 text-[8px] leading-none text-red-500 border-red-300 dark:border-red-800 dark:text-red-400">
      {value}
    </Badge>
  )

  const label = isValid
    ? t('concept_mapping.validity_valid')
    : (INVALID_LABEL_KEYS[value] ? t(INVALID_LABEL_KEYS[value]) : t('concept_mapping.validity_invalid', { value }))

  return (
    <div className="flex justify-center">
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </div>
  )
}
