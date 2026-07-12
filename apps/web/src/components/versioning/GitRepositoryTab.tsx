import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, KeyRound, Link2Off, Loader2 } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { isServerMode } from '@/lib/api-client'
import type { GitRemoteConfig } from '@/types'
import type { GitScope } from '@/lib/api/git'
import { GitSyncPanel } from './GitSyncPanel'

interface GitRepositoryTabProps {
  /** Current git link, or null when unlinked. */
  gitRemote: GitRemoteConfig | null
  /** Persist a git link (or null to unlink). */
  onSave: (config: GitRemoteConfig | null) => void | Promise<void>
  /** Scope + id enable the push-only sync panel once linked (server mode only). */
  syncScope?: GitScope
  syncId?: string
}

/**
 * Two-state Git repository tab, shared by the versioning pages.
 *  - Unlinked: a compact connect form (URL + optional access token).
 *  - Linked: a one-line summary (repo URL + private badge + disconnect) so the
 *    sync panel below gets the room to show the repo's files.
 * The branch is no longer typed here — it's detected on connect and switched
 * from the sync panel's dropdown.
 */
export function GitRepositoryTab({ gitRemote, onSave, syncScope, syncId }: GitRepositoryTabProps) {
  const { t } = useTranslation()
  const [url, setUrl] = useState(gitRemote?.url ?? '')
  const [token, setToken] = useState('')
  const [linked, setLinked] = useState(!!gitRemote?.url)
  const [saving, setSaving] = useState(false)
  // Whether an access token backs the current link (private repo). The backend
  // never returns the token, so this is only known within the session that set it.
  const [hasToken, setHasToken] = useState(!!gitRemote?.authToken)

  const canConnect = url.trim().length > 0
  const linkedUrl = gitRemote?.url ?? url
  const branch = gitRemote?.branch || 'main'

  const handleConnect = async () => {
    if (!canConnect || saving) return
    setSaving(true)
    try {
      await onSave({ url: url.trim(), branch, authToken: token || undefined })
      setHasToken(!!token)
      setLinked(true)
    } finally {
      setSaving(false)
    }
  }

  const handleDisconnect = async () => {
    if (saving) return
    setSaving(true)
    try {
      await onSave(null)
      setLinked(false)
      setUrl('')
      setToken('')
      setHasToken(false)
    } finally {
      setSaving(false)
    }
  }

  if (linked) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {/* Compact connection summary — keeps the config out of the way so the
            sync panel below owns the space. */}
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm">
          <GitBranch size={15} className="shrink-0 text-muted-foreground" />
          <a
            href={linkedUrl}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 truncate text-xs font-medium hover:underline"
            title={linkedUrl}
          >
            {linkedUrl}
          </a>
          {hasToken && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              <KeyRound size={10} />
              {t('versioning.remote_private')}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 text-xs text-muted-foreground hover:text-destructive"
            onClick={handleDisconnect}
            disabled={saving}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Link2Off size={13} />}
            {t('versioning.remote_disconnect')}
          </Button>
        </div>

        {isServerMode() && syncScope && syncId ? (
          <GitSyncPanel scope={syncScope} id={syncId} defaultBranch={branch} />
        ) : (
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('versioning.remote_requires_backend')}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs">{t('versioning.remote_url')}</Label>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('versioning.remote_url_placeholder')}
          className="h-9 text-sm"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t('versioning.remote_token')}</Label>
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t('versioning.remote_token_placeholder')}
          className="h-9 text-sm"
        />
        <p className="text-[11px] text-muted-foreground leading-relaxed">{t('versioning.remote_token_hint')}</p>
      </div>
      <div className="flex justify-end">
        <Button onClick={handleConnect} disabled={!canConnect || saving} className="gap-1.5">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <GitBranch size={14} />}
          {t('versioning.remote_connect')}
        </Button>
      </div>
    </div>
  )
}
