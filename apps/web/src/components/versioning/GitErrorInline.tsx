import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface GitErrorInlineProps {
  /** Short, friendly line. Defaults to a generic "operation failed" message. */
  message?: string
  /** Full underlying error, shown in the info tooltip. */
  detail: string
}

/**
 * Compact git error: one short line + an info icon whose tooltip shows the full
 * raw message. Shared by every git surface (import dialog, versioning tab/panel)
 * so error display is consistent without per-case message mapping.
 */
export function GitErrorInline({ message, detail }: GitErrorInlineProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
      <p className="min-w-0 flex-1 text-xs text-destructive">{message ?? t('versioning.git_error_generic')}</p>
      {detail && (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={t('versioning.git_error_details')} className="shrink-0 text-destructive/70 hover:text-destructive">
                <Info size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-sm">
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed">{detail}</pre>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  )
}
