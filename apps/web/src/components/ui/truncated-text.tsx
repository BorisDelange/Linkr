import { useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface TruncatedTextProps {
  /** Full text; shown truncated inline and in full inside the tooltip. */
  text: string
  /** Number of lines before clamping. 1 = single-line ellipsis (default). */
  lines?: number
  className?: string
  /**
   * Show the tooltip even when the text fits, so its copy button is always
   * reachable. Off by default: the tooltip exists to reveal what is cut off,
   * and a table full of always-on tooltips is noisy to move through.
   */
  alwaysShow?: boolean
}

/**
 * Render text clamped to `lines`, with the full value in a hover tooltip
 * (default styled: dark background, light text, rounded). Overflow is measured
 * on hover (after layout settles), so the tooltip only appears when the text is
 * actually cut. `block` + width clamp keeps it from widening a flex container.
 *
 * The tooltip is readable, not just glanceable: its text is selectable and it
 * carries a copy button, so a long concept name can be lifted out of a narrow
 * column. That means it must NOT close the moment the pointer leaves the cell —
 * `closeDelay` keeps it alive long enough to move into it, and hovering the
 * tooltip itself keeps it open.
 *
 * Cost note: until the text actually overflows this renders a bare <p>. The
 * Radix tooltip only mounts once hover proves the text is cut, so a table of
 * these is not a table of live tooltips. `alwaysShow` opts out of that, mounting
 * a tooltip per cell — worth it where copying any value matters more than the
 * render cost, not as a blanket default.
 */
export function TruncatedText({ text, lines = 1, className, alwaysShow = false }: TruncatedTextProps) {
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

  if (!truncated && !alwaysShow) return content

  return (
    <TooltipProvider delayDuration={200}>
      {/* Hoverable content (Radix default) is what lets the pointer travel into
          the tooltip to select or copy without it closing. */}
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-wrap whitespace-pre-wrap break-words">
          <div className="flex items-start gap-1.5">
            <span className="select-text">{text}</span>
            <CopyButton text={text} />
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** Copy-to-clipboard control shown inside the tooltip, with a brief tick on success. */
function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? t('common.copied') : t('common.copy')}
      className="mt-px shrink-0 rounded p-0.5 opacity-70 hover:bg-white/15 hover:opacity-100"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  )
}
