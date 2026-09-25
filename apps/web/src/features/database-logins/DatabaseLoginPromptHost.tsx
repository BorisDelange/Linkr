import { useDatabaseLoginPrompt } from '@/stores/database-login-prompt'
import { DatabaseLoginDialog } from './DatabaseLoginDialog'

/** Mounted once in server mode: answers the prompts `apiFetch` raises when a
 *  database needs the user's own login, so no page has to handle the 428. */
export function DatabaseLoginPromptHost() {
  const pending = useDatabaseLoginPrompt((s) => s.pending)
  const settle = useDatabaseLoginPrompt((s) => s.settle)
  if (!pending) return null
  return (
    <DatabaseLoginDialog
      key={pending.dataSourceId}
      dataSourceId={pending.dataSourceId}
      sessionOnly={pending.sessionOnly}
      open
      onOpenChange={(open) => { if (!open) settle(false) }}
      onSaved={() => settle(true)}
    />
  )
}
