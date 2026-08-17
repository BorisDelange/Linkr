import { Layers } from 'lucide-react'
import { cn } from '@/lib/utils'

/** One skeleton block in the preview: a widget-shaped placeholder. */
interface Block {
  /** Grid span out of 6 columns. */
  span: number
  /** Height class — mixed heights are what make the preview read as a page. */
  tall?: boolean
  /** Draws the diagonals of an image/figure placeholder instead of text lines. */
  figure?: boolean
}

/**
 * A deterministic block layout for a tab, derived from its widget count so the
 * card mirrors how full the tab actually is. Keyed off the count alone: the
 * preview is a hint, not a faithful thumbnail, and rendering the real layouts
 * would mean mounting every sub-tab's grid.
 */
function blocksFor(widgetCount: number): Block[] {
  if (widgetCount === 0) return []
  if (widgetCount === 1) return [{ span: 6, tall: true, figure: true }]
  if (widgetCount === 2) return [{ span: 3, tall: true, figure: true }, { span: 3, tall: true }]
  if (widgetCount === 3) {
    return [{ span: 6, figure: true }, { span: 3, tall: true }, { span: 3, tall: true, figure: true }]
  }
  if (widgetCount === 4) {
    return [{ span: 3, figure: true }, { span: 3 }, { span: 3, tall: true }, { span: 3, tall: true, figure: true }]
  }
  // Five or more: a denser page, capped so the card stays a glanceable summary.
  return [
    { span: 4, tall: true, figure: true },
    { span: 2, tall: true },
    { span: 2 },
    { span: 2, figure: true },
    { span: 2 },
    { span: 6, figure: true },
  ]
}

interface SubTabPreviewCardProps {
  name: string
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
  widgetCount,
  isContainer,
  onClick,
}: SubTabPreviewCardProps) {
  const blocks = blocksFor(widgetCount)

  return (
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
      <div
        aria-hidden
        className="grid h-28 grid-cols-6 gap-1.5 border-b bg-muted/30 p-2"
      >
        {blocks.length === 0 ? (
          <div className="col-span-6 flex items-center justify-center">
            <div className="h-full w-full rounded border border-dashed border-muted-foreground/25" />
          </div>
        ) : (
          blocks.map((block, i) => (
            <div
              key={i}
              className={cn(
                'flex flex-col gap-1 rounded border bg-background/60 p-1.5',
                'transition-colors group-hover:border-primary/30',
                block.tall ? 'row-span-2' : 'row-span-1',
              )}
              style={{ gridColumn: `span ${block.span}` }}
            >
              {block.figure ? (
                // Crossed diagonals — the conventional "image goes here" mark.
                <svg
                  className="h-full w-full text-muted-foreground/30"
                  viewBox="0 0 40 24"
                  preserveAspectRatio="none"
                >
                  <path
                    d="M0 0 L40 24 M40 0 L0 24"
                    stroke="currentColor"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              ) : (
                <>
                  <div className="h-1 w-2/3 rounded-full bg-muted-foreground/25" />
                  <div className="h-1 w-full rounded-full bg-muted-foreground/15" />
                  <div className="h-1 w-4/5 rounded-full bg-muted-foreground/15" />
                </>
              )}
            </div>
          ))
        )}
      </div>

      <div className="flex min-w-0 items-center gap-1.5 px-2.5 py-2">
        {isContainer && <Layers size={11} className="shrink-0 text-muted-foreground" />}
        <span className="truncate text-xs font-medium group-hover:text-primary">{name}</span>
      </div>
    </button>
  )
}
