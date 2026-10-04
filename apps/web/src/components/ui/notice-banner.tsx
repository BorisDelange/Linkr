import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface NoticeBannerProps {
  /** `warning` (amber): something is missing and limits what works.
   *  `danger` (red): the entity cannot work until it is fixed. */
  tone: 'warning' | 'danger'
  title: string
  description?: ReactNode
  /** A button or link that fixes it, on the right. */
  action?: ReactNode
  /** Shows a ✕ that hides the band; the caller decides for how long. */
  onDismiss?: () => void
  className?: string
}

/**
 * A full-width band that says what is wrong with the entity on screen and how
 * to fix it. Placed under a page's tab bar when it holds for every tab.
 */
export function NoticeBanner({ tone, title, description, action, onDismiss, className }: NoticeBannerProps) {
  const { t } = useTranslation()
  const danger = tone === 'danger'
  return (
    <div
      role="status"
      className={cn(
        'flex shrink-0 items-center gap-3 rounded-lg border px-4 py-2.5',
        danger ? 'border-destructive/30 bg-destructive/5' : 'border-amber-500/40 bg-amber-500/10',
        className,
      )}
    >
      <AlertTriangle size={14} className={cn('shrink-0', danger ? 'text-destructive' : 'text-amber-600 dark:text-amber-500')} />
      <div className="min-w-0 flex-1 text-xs">
        <p className={cn('font-medium', danger ? 'text-destructive' : 'text-amber-700 dark:text-amber-400')}>{title}</p>
        {description && <div className="text-muted-foreground">{description}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label={t('common.close')}
          title={t('common.close')}
          className="shrink-0 self-start text-muted-foreground"
        >
          <X />
        </Button>
      )}
    </div>
  )
}
