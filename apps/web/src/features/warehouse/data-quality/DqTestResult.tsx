import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TestResult } from './use-check-test'

/** A test's outcome under the editor, green or red, until closed. */
export function DqTestResult({ result, onClose }: { result: TestResult; onClose: () => void }) {
  return (
    <div className={cn(
      'flex items-start gap-2 border-t px-3 py-2 text-xs',
      result.success ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5',
    )}>
      <div className="min-w-0 flex-1 space-y-0.5">
        {result.lines.map((line, i) => (
          <p key={i} className={cn(i === 0 ? 'font-medium' : 'text-muted-foreground', 'whitespace-pre-wrap')}>{line}</p>
        ))}
      </div>
      <Button variant="ghost" size="icon-xs" onClick={onClose}>
        <X size={12} />
      </Button>
    </div>
  )
}
