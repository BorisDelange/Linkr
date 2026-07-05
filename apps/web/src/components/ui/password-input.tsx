import * as React from 'react'
import { Eye, EyeOff } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** Password field with a show/hide toggle button. */
function PasswordInput({ className, ...props }: React.ComponentProps<'input'>) {
  const [visible, setVisible] = React.useState(false)

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        className={cn('pr-9', className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex items-center px-2.5"
        aria-label={visible ? 'Hide password' : 'Show password'}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  )
}

export { PasswordInput }
