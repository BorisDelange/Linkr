import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { GitErrorCode } from '@/lib/api/git'

interface GitErrorInlineProps {
  /** Short, friendly line. Defaults to the message for `code`, else a generic one. */
  message?: string
  /** Full underlying error, shown in the info tooltip. */
  detail: string
  /** Typed failure from the backend: names the cause instead of "something went wrong". */
  code?: GitErrorCode
}

function codeMessage(t: (k: string) => string, code: GitErrorCode | undefined): string | undefined {
  switch (code) {
    case 'auth_required': return t('versioning.git_error_auth_required')
    case 'auth_failed': return t('versioning.git_error_auth_failed')
    case 'not_found': return t('versioning.git_error_not_found')
    case 'network': return t('versioning.git_error_network')
    case 'pull_required': return t('versioning.git_error_pull_required')
    default: return undefined
  }
}

/**
 * Compact git error: one short line + an info icon whose tooltip shows the full
 * raw message. Shared by every git surface (import dialog, versioning tab/panel)
 * so error display is consistent without per-case message mapping.
 *
 * The backend sends a typed `code` with every git failure; passing it turns the
 * generic line into one that names the cause, which is usually the difference
 * between "something went wrong" and knowing a token is missing.
 */
export function GitErrorInline({ message, detail, code }: GitErrorInlineProps) {
  const { t } = useTranslation()
  const line = message ?? codeMessage(t, code) ?? t('versioning.git_error_generic')
  // An info bubble that repeats the line it sits next to is noise: only offer it
  // when the raw error actually says more than the friendly summary.
  const showDetail = detail !== '' && detail !== line
  return (
    // min-w-0: as a flex/grid child (the dialog body is one), the default
    // min-width:auto floors this box at its longest unbreakable word, so a raw
    // error with no spaces widened it past the border instead of wrapping inside.
    <div className="min-w-0 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
      <div className="flex items-start gap-1.5">
        <p className="min-w-0 flex-1 break-words text-xs text-destructive">{line}</p>
        {showDetail && (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label={t('versioning.git_error_details')} className="shrink-0 text-destructive/70 hover:text-destructive">
                  <Info size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-sm">
                {/* break-all, not break-words: the raw error is often one long
                    unbroken string (a JSON body, a URL), which `break-word` leaves
                    intact — and it then runs straight out of the box. */}
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed">{detail}</pre>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {/* What git itself said. It was tooltip-only, which hid the one line that
          usually identifies the problem behind a hover the user had no reason
          to try. */}
      {showDetail && (
        <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-destructive/80">{detail}</pre>
      )}
    </div>
  )
}
