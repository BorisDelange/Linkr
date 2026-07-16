import { STATUS_COLORS, UNMAPPED_COLOR } from '@/lib/concept-mapping/status-colors'
import type { EffectiveMappingStatus } from '@/types'

export interface StatusSegment {
  status: EffectiveMappingStatus | 'unmapped'
  count: number
  label: string
}

interface StatusBarProps {
  segments: StatusSegment[]
  /** Total used to scale the segment widths (usually the source-concept total). */
  total: number
  className?: string
}

function segmentColor(status: StatusSegment['status']): string {
  return status === 'unmapped' ? UNMAPPED_COLOR : STATUS_COLORS[status]
}

/** Horizontal stacked bar showing the status distribution of a group of source
 *  concepts, using the shared status color code. Widths are proportional to the
 *  given total so bars across rows are comparable. */
export function StatusBar({ segments, total, className }: StatusBarProps) {
  const safeTotal = total > 0 ? total : 1
  return (
    <div className={`flex h-2.5 w-full overflow-hidden rounded-full bg-muted ${className ?? ''}`}>
      {segments.map((seg) =>
        seg.count > 0 ? (
          <div
            key={seg.status}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(seg.count / safeTotal) * 100}%`, backgroundColor: segmentColor(seg.status) }}
            title={`${seg.label}: ${seg.count.toLocaleString()}`}
          />
        ) : null,
      )}
    </div>
  )
}
