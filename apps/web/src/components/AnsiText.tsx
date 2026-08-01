import { useMemo } from 'react'
import { parseAnsi } from '@/lib/ansi'
import { cn } from '@/lib/utils'

/** Render ANSI-coloured text (build/install logs) as styled spans inside a <pre>.
 *  No dependency, no dangerouslySetInnerHTML — just parsed SGR segments. */
export function AnsiText({ text, className }: { text: string; className?: string }) {
  const segments = useMemo(() => parseAnsi(text), [text])
  return (
    <pre className={className}>
      {segments.map((seg, i) => (
        <span key={i} className={cn(seg.className, seg.bold && 'font-semibold')}>
          {seg.text}
        </span>
      ))}
    </pre>
  )
}
