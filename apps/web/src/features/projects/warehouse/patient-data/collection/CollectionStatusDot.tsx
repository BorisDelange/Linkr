import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { DatasetColumn } from '@/types'
import { completionOf } from './constraints'

/**
 * Collection progress for the patient on screen, as a dot on the Collection button.
 *
 * Three states, so the collector can tell at a glance whether this patient still
 * needs them without opening the panel: grey for untouched, amber for started, green
 * for done. "Done" means every REQUIRED field is filled — with no required fields
 * that reduces to "something was entered", which is the most either can honestly
 * claim about a form whose fields are all optional.
 */
export function CollectionStatusDot({
  fields, className,
}: {
  fields: { column: DatasetColumn; value: unknown }[]
  className?: string
}) {
  const { t } = useTranslation()
  if (fields.length === 0) return null

  const { filled, total, missingRequired } = completionOf(fields)
  const state = filled === 0 ? 'empty' : missingRequired === 0 ? 'complete' : 'partial'

  return (
    <span
      title={t(`patient_data.collection_status_${state}`, { filled, total })}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        state === 'complete' && 'bg-emerald-500',
        state === 'partial' && 'bg-amber-500',
        state === 'empty' && 'bg-muted-foreground/40',
        className,
      )}
    />
  )
}
