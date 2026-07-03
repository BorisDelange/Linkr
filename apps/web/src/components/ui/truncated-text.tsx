import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface TruncatedTextProps {
  /** Full text; shown truncated inline and in full inside the tooltip. */
  text: string
  /** Number of lines before clamping. 1 = single-line ellipsis (default). */
  lines?: number
  className?: string
}

/**
 * Render text clamped to `lines`, with the full value in a hover tooltip
 * (default styled: dark background, light text, rounded). Overflow is measured
 * on hover (after layout settles), so the tooltip only appears when the text is
 * actually cut. `block` + width clamp keeps it from widening a flex container.
 */
export function TruncatedText({ text, lines = 1, className }: TruncatedTextProps) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [truncated, setTruncated] = useState(false)

  const check = () => {
    const el = ref.current
    if (!el) return
    setTruncated(el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight + 1)
  }

  const clampClass = lines === 1 ? 'truncate' : 'overflow-hidden'
  const clampStyle =
    lines === 1
      ? undefined
      : { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical' as const }

  const content = (
    <p
      ref={ref}
      onPointerEnter={check}
      className={cn('block min-w-0 max-w-full', clampClass, className)}
      style={clampStyle}
    >
      {text}
    </p>
  )

  if (!truncated) return content

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs whitespace-pre-wrap">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
