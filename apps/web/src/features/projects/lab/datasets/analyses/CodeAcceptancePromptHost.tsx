import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { DialogShell } from '@/components/ui/dialog-shell'
import { formatApiError } from '@/lib/api-client'
import { acceptCode } from '@/lib/api/code-acceptance'
import { useCodeAcceptancePrompt } from '@/stores/code-acceptance-prompt'

const LANGUAGE_LABEL = { python: 'Python', r: 'R', sql: 'SQL' }

/** Mounted once in server mode: answers the requests `withCodeAcceptance` raises when
 *  the server refuses code this user has not accepted, so no page has to handle it. */
export function CodeAcceptancePromptHost() {
  const { t } = useTranslation()
  const pending = useCodeAcceptancePrompt((s) => s.pending)
  const settle = useCodeAcceptancePrompt((s) => s.settle)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (pending.length === 0) return null

  const accept = async () => {
    setBusy(true)
    setError(null)
    try {
      await acceptCode([...new Set(pending.flatMap((p) => (p.source ? [p.code, p.source] : [p.code])))])
      settle(true)
    } catch (err) {
      setError(formatApiError(err).summary ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      open
      onOpenChange={(open) => { if (!open) settle(false) }}
      kind="workbench"
      title={t('code_acceptance.title', { count: pending.length })}
      description={t('code_acceptance.description')}
      onConfirm={() => void accept()}
      confirmLabel={t('code_acceptance.accept')}
      cancelLabel={t('code_acceptance.decline')}
      busy={busy}
      noEnterSubmit
    >
      <div className="space-y-3">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {pending.map((item) => (
          <section key={item.code} className="rounded-md border">
            <header className="flex items-center gap-2 border-b px-3 py-1.5 text-xs font-medium">
              <span className="min-w-0 truncate">{item.label || t('code_acceptance.unnamed')}</span>
              <Badge variant="outline">{LANGUAGE_LABEL[item.language]}</Badge>
            </header>
            <pre className="max-h-96 overflow-auto p-3 font-mono text-xs whitespace-pre">{item.code}</pre>
          </section>
        ))}
      </div>
    </DialogShell>
  )
}
