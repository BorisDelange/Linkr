import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useFittedSelectionLabel } from '@/hooks/use-fitted-selection-label'

/**
 * Above this many chosen options, the trigger counts instead of naming.
 *
 * Naming beats counting only while the list is short enough to take in at a
 * glance: "Age, Sex" is more useful than "2 selected", but eight column names
 * run together are less readable than "8 selected" AND force the control wider
 * than its neighbours. Three is where the trade turns.
 */
const MAX_NAMED = 3

/**
 * What a multi-select trigger reads when some options are chosen.
 *
 * Names a short selection, counts a long one, and says the empty and
 * everything-selected cases in words rather than making the reader do
 * arithmetic on "0 selected" / "7 selected".
 *
 * The measurement exists for the middle case: two long column names can still
 * overflow a narrow panel, and a list clipped mid-word is worse than a count.
 * Measuring beats guessing from string length because the panel is resizable
 * and character widths vary by an order of magnitude between `i` and `M`.
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

  const canName = labels.length > 0 && labels.length <= MAX_NAMED && labels.length < total

  return (
    // min-w-0 is load-bearing: without it the flex item sizes to its content,
    // pushing the whole control wider than the panel instead of truncating.
    <span ref={containerRef} className={cn('relative min-w-0 flex-1 overflow-hidden text-left', className)}>
      {/* Measured off-screen at its natural width; `fits` is derived from it.
          Only mounted while naming is a candidate, so a long selection does no
          layout work at all. */}
      {canName && (
        <span
          ref={probeRef}
          aria-hidden
          className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
        >
          {joined}
        </span>
      )}
      <span className="block truncate">{canName && fits ? joined : summary}</span>
    </span>
  )
}
