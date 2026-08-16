import { Library } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedText } from '@/components/ui/truncated-text'

/** Columns whose own renderer wins over the generic copy tooltip — they are
 *  badges or buttons, not text worth lifting out of a cell. */
export const NO_TOOLTIP_COLUMNS = new Set([
  'standard_concept',
  'record_count',
  'patient_count',
  'concept_set_name',
])

/** Columns rendered in a monospace font (kept in the tooltip cell). */
export const MONO_COLUMNS = new Set(['concept_code', 'concept_id'])

/** A count cell: the number when known, or a dash when the cache holds no count
 *  for this concept yet. Refresh replaces the cache atomically, so a cell never
 *  shows a partial/blank state mid-refresh — it keeps the previous value. */
export function CountCell({ value }: { value: number | undefined }) {
  if (value !== undefined && value !== null) {
    return <span className="tabular-nums">{Number(value).toLocaleString()}</span>
  }
  return <span className="text-muted-foreground">—</span>
}

/** The data-dictionary cell: one button per set the concept belongs to, since a
 *  concept can be in several and each opens its own detail. */
export function ConceptSetCell({
  value,
  onOpen,
  openLabel,
}: {
  value: string
  onOpen?: (setName: string) => void
  openLabel: string
}) {
  if (!value) return <span className="text-[10px] text-muted-foreground">—</span>
  return (
    <div className="flex min-w-0 items-center gap-1">
      {value.split(', ').map((name) => (
        <Tooltip key={name}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onOpen?.(name)
              }}
            >
              <Library size={11} className="shrink-0" />
              <span className="truncate">{name}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="text-xs">
            {openLabel}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

/**
 * Render one table cell the way the Concepts table does: the column's own
 * renderer when it is graphical, otherwise the value wrapped so it reveals
 * itself on hover when the column is too narrow to show it whole.
 *
 * These tables are for picking a row, so the tooltip is deliberately read-only:
 * it appears only when the text is actually cut, carries no copy button, and
 * does not take the pointer — a hoverable panel per cell sat over the rows
 * below and made them awkward to click. The mapping-project tables keep the
 * richer copyable tooltip, where lifting a code out of a cell is the point.
 *
 * `rendered` is the column's output; it is used as-is for the columns listed in
 * NO_TOOLTIP_COLUMNS, and replaced by the tooltip otherwise.
 */
export function conceptCellContent(
  columnId: string,
  raw: unknown,
  rendered: React.ReactNode,
): React.ReactNode {
  const useTooltip =
    !NO_TOOLTIP_COLUMNS.has(columnId) && raw != null && String(raw) !== ''
  if (!useTooltip) return rendered
  return (
    <TruncatedText
      readOnly
      text={String(raw)}
      className={MONO_COLUMNS.has(columnId) ? 'font-mono' : undefined}
    />
  )
}
