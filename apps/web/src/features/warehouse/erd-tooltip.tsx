import type { ComponentProps } from 'react'
import { useStore } from '@xyflow/react'
import { TooltipContent } from '@/components/ui/tooltip'

/** Canvas distance from a row's edge to past its connection point and hover ring. */
const HANDLE_REACH = 28

/**
 * A table row's tooltip, kept clear of the row's connection point: a tooltip
 * over it steals its hover. The point sits a fixed distance out in canvas
 * units, so the offset follows the zoom. Mounted only while open, so only an
 * open tooltip listens to zooming.
 */
export function HandleTooltipContent(props: Omit<ComponentProps<typeof TooltipContent>, 'sideOffset'>) {
  const zoom = useStore((s) => s.transform[2])
  return <TooltipContent {...props} sideOffset={Math.round(HANDLE_REACH * zoom)} />
}
