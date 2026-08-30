import { useId } from 'react'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import { cn } from '@/lib/utils'

interface FormFieldProps {
  label: React.ReactNode
  /** Adds the required asterisk. */
  required?: boolean
  /** Help text under the control. */
  hint?: React.ReactNode
  className?: string
  /** The control. Given the generated id so the label points at it. */
  children: (props: { id: string }) => React.ReactNode
}

/**
 * One labelled form field: label above, control below, optional hint.
 *
 * Exists because the same five lines were hand-written in ~33 dialogs, which is
 * how two spacings drifted apart — some fields sat at `space-y-1`, others at
 * `space-y-1.5`, and the labels ended up visibly closer to their inputs in some
 * dialogs than others. The gap is a property of the form, not of each dialog.
 *
 * Renders the control through a function so the field can hand it a generated
 * id: a bare <Label> next to an <Input> looks right but is not associated with
 * it, so clicking the label does nothing and a screen reader announces neither.
 */
export function FormField({ label, required, hint, className, children }: FormFieldProps) {
  const id = useId()
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required && <RequiredMark />}
      </Label>
      {children({ id })}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
