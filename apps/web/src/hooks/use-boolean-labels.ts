import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { BooleanLabels } from '@/lib/dataset-utils'

/** Localized words for boolean cells, ready to hand to `displayCellValue`.
 *  Memoized so the object identity is stable across renders. */
export function useBooleanLabels(): BooleanLabels {
  const { t } = useTranslation()
  return useMemo(() => ({ true: t('common.true'), false: t('common.false') }), [t])
}
