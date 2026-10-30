import type { ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'

interface ConceptPickerToolbarProps {
  /** Controls ahead of the others (e.g. the database the list reads). */
  leading?: ReactNode
  /** Extra controls (e.g. importing a saved list). */
  children?: ReactNode
}

/** The bar above the concept lists — the project Concepts page, a database's
 *  Concepts tab and the concept pickers — for what is not a column filter.
 *  Searching and filtering happen in the table's own column filters, over
 *  every concept. Renders nothing when there is nothing to hold. */
export function ConceptPickerToolbar({ leading, children }: ConceptPickerToolbarProps) {
  if (!leading && !children) return null
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
        {leading}
        {children}
      </div>
    </TooltipProvider>
  )
}
