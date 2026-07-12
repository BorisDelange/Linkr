import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ChevronRight } from 'lucide-react'
import { gitErrorMessageKey } from '@/lib/git-error-message'
import type { GitErrorCode } from '@/lib/api/git'

interface GitErrorNoticeProps {
  code: GitErrorCode
  /** Raw git output, shown only when the user expands "details". */
  raw: string
}

/** Friendly git error (one clear line) with the raw git output tucked behind a
 *  collapsible "details" toggle, so the technical message stays available. */
export function GitErrorNotice({ code, raw }: GitErrorNoticeProps) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)

  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
      <div className="flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-destructive">{t(gitErrorMessageKey(code))}</p>
          {raw && (
            <>
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="mt-1 flex items-center gap-1 text-[10px] text-destructive/70 hover:text-destructive"
              >
                <ChevronRight size={10} className={showRaw ? 'rotate-90 transition-transform' : 'transition-transform'} />
                {t('versioning.git_err_details')}
              </button>
              {showRaw && (
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-background/50 p-1.5 text-[10px] text-muted-foreground">
                  {raw}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
