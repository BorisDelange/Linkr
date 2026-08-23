import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useFittedSelectionLabel } from '@/hooks/use-fitted-selection-label'

/**
 * What a multi-select trigger reads when some options are chosen.
 *
 * Names the options while they fit ("Mean ± SD, Median [IQR]") and falls back to
 * a count ("2 selected") when they do not — a clipped list is worse than either.
 * The empty and everything-selected cases get words of their own rather than a
 * count, because "0 selected" and "7 selected" make the reader do arithmetic to
 * learn something the label could just say.
 */
export function SelectionTriggerLabel({
  labels,
  total,
  className,
}: {
  /** The chosen options, already localized and in display order. */
  labels: string[]
  /** How many options exist, to recognize the everything-selected case. */
  total: number
  className?: string
}) {
  const { t } = useTranslation()
  const { containerRef, probeRef, joined, fits } = useFittedSelectionLabel(labels)

  const summary =
    labels.length === 0
      ? t('common.none_selected')
      : labels.length === total
        ? t('common.all_selected')
        : t('common.n_selected', { count: labels.length })

  return (
    <span ref={containerRef} className={cn('relative min-w-0 flex-1 overflow-hidden text-left', className)}>
      {/* Measured off-screen at its natural width; `fits` is derived from it. */}
      <span
        ref={probeRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
      >
        {joined}
      </span>
      <span className="block truncate">
        {labels.length > 0 && labels.length < total && fits ? joined : summary}
      </span>
    </span>
  )
}
