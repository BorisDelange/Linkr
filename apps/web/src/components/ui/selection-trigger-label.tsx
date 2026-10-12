import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { useFittedSelectionLabel } from '@/hooks/use-fitted-selection-label'

/**
 * Above this many chosen options, the trigger counts without measuring: so many
 * names could never fit the trigger, and joining them is wasted layout work.
 */
const MAX_NAMED = 20

/**
 * For a trigger padded for text (`px-3`): pulls a badge row in to the same
 * distance from the left edge as from the top and bottom, where text padding
 * would leave a pill visibly adrift. Keyed on the shown row only, so the
 * "N selected" fallback keeps the text padding.
 */
export const BADGE_TRIGGER_INSET = 'has-[[data-badges-shown]]:pl-1.5'

/**
 * What a multi-select trigger reads when some options are chosen.
 *
 * Names the selection whenever it fits the trigger, whatever its size, and
 * counts it once it would overflow: "Protocol" says more than "All selected"
 * when there is a single option, and a list clipped mid-word is worse than a
 * count. Nothing and everything chosen are said in words rather than making
 * the reader do arithmetic on "0 selected" / "7 selected".
 *
 * Each value is a badge, so "Late, onset unknown" cannot read as one value or
 * two; `badges={false}` joins them with commas instead.
 *
 * Measuring beats guessing from string length because the panel is resizable
 * and character widths vary by an order of magnitude between `i` and `M`.
 */
export function SelectionTriggerLabel({
  labels,
  total,
  className,
  badges = true,
  badgeSize = 'default',
}: {
  /** The chosen options, already localized and in display order. */
  labels: string[]
  /** How many options exist, to recognize the everything-selected case. */
  total: number
  className?: string
  badges?: boolean
  /** `xs` for the `h-6` inline filters of a table header. */
  badgeSize?: 'default' | 'xs'
}) {
  const { t } = useTranslation()
  const { containerRef, probeRef, joined, fits } = useFittedSelectionLabel(labels)

  const summary =
    labels.length === 0
      ? t('common.none_selected')
      : labels.length === total
        ? t('common.all_selected')
        : t('common.n_selected', { count: labels.length })

  const canName = labels.length > 0 && labels.length <= MAX_NAMED

  const named = badges ? (
    <span className="flex items-center gap-1">
      {labels.map((label, i) => (
        <Badge key={`${i}-${label}`} variant="secondary" size={badgeSize} className="font-normal">
          {label}
        </Badge>
      ))}
    </span>
  ) : joined

  return (
    // `w-0 flex-1` is load-bearing: the width comes from the trigger, never from
    // the content. Sized by its content, a row of badges widens the trigger and
    // every ancestor up to the panel, and the measurement then always "fits".
    <span ref={containerRef} className={cn('relative w-0 min-w-0 flex-1 overflow-hidden text-left', className)}>
      {/* Measured off-screen at its natural width; `fits` is derived from it.
          Only mounted while naming is a candidate, so a long selection does no
          layout work at all. */}
      {canName && (
        <span
          ref={probeRef}
          aria-hidden
          className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
        >
          {named}
        </span>
      )}
      {canName && fits ? (
        <span className={cn('block', !badges && 'truncate')} data-badges-shown={badges || undefined}>{named}</span>
      ) : (
        <span className="block truncate">{summary}</span>
      )}
    </span>
  )
}
