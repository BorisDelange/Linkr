import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ChevronDown, ChevronRight } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { FormattedError } from '@/lib/api-client'

interface ImportErrorDialogProps {
  /** Formatted error to show, or null to keep the dialog closed. */
  error: FormattedError | null
  onClose: () => void
  /** Optional title override; defaults to the generic import-failed title. */
  title?: string
}

/**
 * Import-failure dialog with a one-line summary and the raw technical detail
 * tucked behind a toggle. Width is capped and the detail scrolls, so a large
 * payload (e.g. a FastAPI validation blob) can never push the OK button
 * off-screen and trap the user.
 */
export function ImportErrorDialog({ error, onClose, title }: ImportErrorDialogProps) {
  const { t } = useTranslation()
  const [showDetail, setShowDetail] = useState(false)

  return (
    <AlertDialog
      open={error !== null}
      onOpenChange={(open) => { if (!open) { setShowDetail(false); onClose() } }}
    >
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{title ?? t('common.import_error_title')}</AlertDialogTitle>
        </AlertDialogHeader>

        <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border p-3 text-sm break-words">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            {error?.summaryKey
              ? t(error.summaryKey, { count: error.summaryCount })
              : error?.summary}
          </span>
        </div>

        {error?.detail && (
          <Collapsible open={showDetail} onOpenChange={setShowDetail}>
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs">
              {showDetail
                ? <ChevronDown className="size-3.5" />
                : <ChevronRight className="size-3.5" />}
              {showDetail ? t('common.hide_details') : t('common.show_details')}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="bg-muted mt-2 max-h-60 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap break-words">
                {error.detail}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}

        <AlertDialogFooter>
          <AlertDialogAction onClick={() => { setShowDetail(false); onClose() }}>
            {t('common.ok')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
