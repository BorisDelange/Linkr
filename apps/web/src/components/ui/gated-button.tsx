import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

type GatedButtonProps = ComponentProps<typeof Button> & {
  /** When false, the button is disabled and a tooltip explains why. */
  allowed: boolean
  /** Tooltip text shown when not allowed. */
  notAllowedReason?: string
}

/**
 * A Button that stays visible but is disabled (greyed) with an explanatory
 * tooltip when the user lacks permission — the agreed posture for inline
 * create/edit/delete actions. Real enforcement is server-side; this is UX only.
 *
 * A disabled element doesn't emit pointer events, so the tooltip target is a
 * wrapping span when not allowed.
 */
export function GatedButton({
  allowed,
  notAllowedReason,
  disabled,
  children,
  ...props
}: GatedButtonProps) {
  if (allowed) {
    return (
      <Button disabled={disabled} {...props}>
        {children}
      </Button>
    )
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Swallow clicks so a disabled action never bubbles to a parent
              (e.g. a clickable card row) and triggers navigation/opening. */}
          <span
            className="inline-flex cursor-not-allowed"
            onClickCapture={(e) => { e.stopPropagation(); e.preventDefault() }}
            onPointerDownCapture={(e) => { e.stopPropagation(); e.preventDefault() }}
          >
            <Button
              disabled
              tabIndex={-1}
              className={props.className}
              variant={props.variant}
              size={props.size}
            >
              {children}
            </Button>
          </span>
        </TooltipTrigger>
        {notAllowedReason && <TooltipContent>{notAllowedReason}</TooltipContent>}
      </Tooltip>
    </TooltipProvider>
  )
}
