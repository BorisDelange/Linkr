import { Layers } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** One skeleton block in the preview: a widget-shaped placeholder. */
interface Block {
  /** Grid span out of 6 columns. */
  span: number
  /** Height class — mixed heights are what make the preview read as a page. */
  tall?: boolean
}

/**
 * A deterministic block layout for a tab, derived from its widget count so the
 * card mirrors how full the tab actually is. Keyed off the count alone: the
 * preview is a hint, not a faithful thumbnail, and rendering the real layouts
 * would mean mounting every sub-tab's grid.
 *
 * Every layout fills exactly the 6×2 grid — a taller one would overflow the
 * card's fixed height and be clipped mid-block.
 */
function blocksFor(widgetCount: number): Block[] {
  if (widgetCount === 0) return []
  if (widgetCount === 1) return [{ span: 6, tall: true }]
  if (widgetCount === 2) return [{ span: 3, tall: true }, { span: 3, tall: true }]
  if (widgetCount === 3) {
    return [{ span: 3, tall: true }, { span: 3 }, { span: 3 }]
  }
  if (widgetCount === 4) {
    return [{ span: 3 }, { span: 3 }, { span: 3 }, { span: 3 }]
  }
  // Five or more: a denser page, capped so the card stays a glanceable summary.
  return [
    { span: 2 },
    { span: 2 },
    { span: 2 },
    { span: 3 },
    { span: 3 },
  ]
}

interface SubTabPreviewCardProps {
  name: string
  /** Resolved for the active language; shown as a hover tooltip when non-empty. */
  description?: string
  widgetCount: number
  /** Sub-tabs of a sub-tab: this child is itself a container. */
  isContainer?: boolean
  onClick: () => void
}

/**
 * A clickable placeholder that stands in for a sub-tab's page: skeleton widget
 * blocks in the body, the tab's name below. Replaces the bare "this tab contains
 * sub-tabs" message, which left the whole viewport empty.
 */
export function SubTabPreviewCard({
  name,
  description,
  widgetCount,
  isContainer,
  onClick,
}: SubTabPreviewCardProps) {
  const blocks = blocksFor(widgetCount)

  const card = (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex flex-col overflow-hidden rounded-lg border bg-card text-left',
        'transition-colors hover:border-primary/50 hover:bg-accent/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {/* The fake page. aria-hidden: it carries no information the label below
          doesn't already give, and its blocks would read as noise to a screen reader. */}
      {/* grid-rows-2 is explicit: without it the row-span-2 blocks create implicit
          auto-sized rows that overflow the fixed height and get clipped mid-widget. */}
      <div
        aria-hidden
        className="grid h-28 grid-cols-6 grid-rows-2 gap-1.5 border-b bg-muted/30 p-2"
      >
        {blocks.length === 0 ? (
          <div className="col-span-6 row-span-2 flex items-center justify-center">
            <div className="h-full w-full rounded border border-dashed border-muted-foreground/25" />
          </div>
        ) : (
          blocks.map((block, i) => (
            <div
              key={i}
              // overflow-hidden: a short block must clip its own lines rather than
              // spill over the neighbour below it.
              className={cn(
                'flex min-h-0 flex-col justify-center gap-1 overflow-hidden rounded border bg-background/60 p-1.5',
                'transition-colors group-hover:border-primary/30',
                block.tall ? 'row-span-2' : 'row-span-1',
              )}
              style={{ gridColumn: `span ${block.span}` }}
            >
              <div className="h-1 w-2/3 shrink-0 rounded-full bg-muted-foreground/20" />
              <div className="h-1 w-full shrink-0 rounded-full bg-muted-foreground/15" />
            </div>
          ))
        )}
      </div>

      {/* bg-card, not the grid's muted tint: the label sits on a clean surface so it
          stays readable against the busy skeleton above it. */}
      <div className="flex min-w-0 items-center gap-1.5 bg-card px-2.5 py-2">
        {isContainer && <Layers size={11} className="shrink-0 text-muted-foreground" />}
        <span className="truncate text-xs font-medium text-foreground group-hover:text-primary">{name}</span>
      </div>
    </button>
  )

  if (!description?.trim()) return card

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{card}</TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64">{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
