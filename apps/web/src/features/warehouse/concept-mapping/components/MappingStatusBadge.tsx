import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import type { MappingStatus } from '@/types'

const statusColors: Record<MappingStatus, string> = {
  unchecked: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  flagged: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  invalid: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  ignored: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
}

interface MappingStatusBadgeProps {
  status: MappingStatus
}

export function MappingStatusBadge({ status }: MappingStatusBadgeProps) {
  const { t } = useTranslation()

  return (
    <Badge className={`text-[10px] font-medium border-0 ${statusColors[status]}`}>
      {t(`concept_mapping.status_${status}`)}
    </Badge>
  )
}
