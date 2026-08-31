import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface CopyIconButtonProps {
  /** Value written to the clipboard. */
  text: string
  /** Icon size in px (default 11, the dense/tooltip size). */
  size?: number
  className?: string
}

/**
 * Bare icon-only copy control, showing a tick for a moment after a successful
 * copy. Sized for dense surfaces (tooltips, list rows); its hover tint is
 * white-on-dark, matching the tooltip's inverted surface.
 */
export function CopyIconButton({ text, size = 11, className }: CopyIconButtonProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

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
      className={cn(
        'shrink-0 rounded p-0.5 opacity-70 hover:bg-white/15 hover:opacity-100',
        className,
      )}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  )
}
