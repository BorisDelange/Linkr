import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, Loader2, Settings } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Button } from '@/components/ui/button'
import { isServerMode } from '@/lib/api-client'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { gitVerifyRemote, gitSetHostToken, gitHostTokenStatus } from '@/lib/api/git'
import { cleanGitUrl } from '@/lib/git-clone'
import { toGitError } from '@/lib/git-error-message'
import type { GitErrorCode, GitScope } from '@/lib/api/git'
import type { GitRemoteConfig } from '@/types'
import { useGitSyncStore } from '@/stores/git-sync-store'
import { GitSyncPanel } from './GitSyncPanel'
import { GitErrorInline } from './GitErrorInline'
import { GitTokenDialog } from './GitTokenDialog'
import { GitConfigDialog } from './GitConfigDialog'

interface GitRepositoryTabProps {
  /** Current git link, or null when unlinked. */
  gitRemote: GitRemoteConfig | null
  /** Persist a git link (or null to unlink). */
  onSave: (config: GitRemoteConfig | null) => void | Promise<void>
  /** Scope + id enable the push-only sync panel once linked (server mode only). */
  syncScope?: GitScope
  syncId?: string
  /** Custom pull UI (forwarded to GitSyncPanel) for scopes with their own pull flow. */
  renderPullDialog?: React.ComponentProps<typeof GitSyncPanel>['renderPullDialog']
  /** Inline pull (forwarded to GitSyncPanel) — preferred over renderPullDialog. */
  renderInlinePull?: React.ComponentProps<typeof GitSyncPanel>['renderInlinePull']
  /** Scope-specific store refresh after a pull (forwarded to GitSyncPanel). */
  onAfterPull?: React.ComponentProps<typeof GitSyncPanel>['onAfterPull']
}

/**
 * Two-state Git repository tab, shared by the versioning pages.
 *  - Unlinked: a connect form (URL + token). The remote is verified before it's
 *    saved; a private repo probed without a token asks for one (auth_required).
 *  - Linked: a one-line summary (repo URL + private badge + edit-token +
 *    disconnect) so the sync panel below gets the room to show the repo's files.
 * The branch is detected on connect and switched from the sync panel's dropdown.
 */
export function GitRepositoryTab({ gitRemote, onSave, syncScope, syncId, renderPullDialog, renderInlinePull, onAfterPull }: GitRepositoryTabProps) {
  const { t } = useTranslation()
  const refreshStatus = useGitSyncStore((s) => s.refreshStatus)
  const [url, setUrl] = useState(gitRemote?.url ?? '')
  const [token, setToken] = useState('')
  const [linked, setLinked] = useState(!!gitRemote?.url)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ code: GitErrorCode; raw: string } | null>(null)
  const [editingToken, setEditingToken] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  // Whether the CURRENT USER has a token stored for this repo's host. Tokens are
  // per (user, host) server-side; the token itself is never returned, only its
  // presence — so this is fetched from the backend, not derived from the config.
  // null = not yet known (fetch in flight); avoids flashing "No token" before it resolves.
  const [hasToken, setHasToken] = useState<boolean | null>(null)

  // gitRemote loads asynchronously (store fetch on mount / direct URL open), so
  // reflect a link that arrives after the first render — otherwise the tab stays
  // on the empty connect form until the user switches tabs and remounts it. Also
  // fetch whether this user already has a token for the host.
  useEffect(() => {
    if (!gitRemote?.url) return
    setLinked(true)
    let cancelled = false
    gitHostTokenStatus(gitRemote.url)
      .then((s) => { if (!cancelled) setHasToken(s.hasToken) })
      .catch(() => { /* leave hasToken as-is */ })
    return () => { cancelled = true }
  }, [gitRemote?.url])

  const canConnect = url.trim().length > 0
  const linkedUrl = gitRemote?.url ?? url
  const branch = gitRemote?.branch || 'main'
  // A private repo failed without a token → highlight the token field as required.
  const tokenRequired = error?.code === 'auth_required'

  const handleConnect = async () => {
    if (!canConnect || saving) return
    setSaving(true)
    setError(null)
    try {
      // Accept a pasted repo web-page URL (…/-/tree/main?…) by cleaning it to the
      // bare clone URL before verifying and storing.
      const cleanUrl = cleanGitUrl(url.trim())
      let resolvedBranch = branch
      // Verify the remote is reachable before persisting, so a wrong URL or a
      // missing/invalid token is rejected up front. Detect the default branch too.
      // A successful verify with a token also stores it for this user + host, so
      // the token-less sync ops can use it afterwards.
      if (isServerMode()) {
        const check = await gitVerifyRemote(cleanUrl, token || undefined)
        if (check.default) resolvedBranch = check.default
      }
      // The link on the entity is url + branch only — the token lives per-user.
      await onSave({ url: cleanUrl, branch: resolvedBranch })
      setUrl(cleanUrl)
      setHasToken(!!token)
      setLinked(true)
    } catch (err) {
      setError(toGitError(err))
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

  const handleTokenSaved = async (newToken: string) => {
    // Token is per (user, host), not stored on the entity — save it directly.
    await gitSetHostToken(linkedUrl, newToken)
    setHasToken(!!newToken)
    // Re-run the sync status now the token changed: a private repo that was showing
    // "auth failed" (or every file as "added" over a phantom-empty remote) resolves
    // to the real file list without waiting for a manual refresh.
    if (syncScope && syncId) void refreshStatus(syncScope, syncId, branch)
  }

  // All versioning (remote verify + push/pull sync) runs server-side, so the whole
  // tab is unavailable in client-only mode — show the notice instead of a connect
  // form that could only fail.
  if (!isServerMode()) {
    return <ServerModeNotice inline className="mx-auto" />
  }

  if (linked) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {/* No permanent settings bar: the repo URL, token and Disconnect live in
            the Config dialog, opened from the panel's toolbar. They are touched
            once when linking and never again, so they don't earn the space. */}
        {syncScope && syncId ? (
          <GitSyncPanel
            scope={syncScope}
            id={syncId}
            defaultBranch={branch}
            renderPullDialog={renderPullDialog}
            renderInlinePull={renderInlinePull}
            onAfterPull={onAfterPull}
            onOpenConfig={() => setConfigOpen(true)}
          />
        ) : (
          // Without a sync panel there is no toolbar to hang Config off, so the
          // repo summary stays inline — otherwise the link would be unreachable.
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
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1 text-xs text-muted-foreground"
              onClick={() => setConfigOpen(true)}
            >
              <Settings size={13} />
              {t('versioning.config_button')}
            </Button>
          </div>
        )}

        {configOpen && (
          <GitConfigDialog
            url={linkedUrl}
            hasToken={hasToken}
            saving={saving}
            onEditToken={() => { setConfigOpen(false); setEditingToken(true) }}
            onDisconnect={async () => { setConfigOpen(false); await handleDisconnect() }}
            onClose={() => setConfigOpen(false)}
          />
        )}

        {editingToken && (
          <GitTokenDialog url={linkedUrl} onSave={handleTokenSaved} onClose={() => setEditingToken(false)} />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>{t('versioning.remote_url')}</Label>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('versioning.remote_url_placeholder')}
          className="h-9 text-sm"
        />
      </div>
      <div className="space-y-2">
        <Label>
          {t('versioning.remote_token')}
          {tokenRequired && <span className="ml-1 text-destructive">*</span>}
        </Label>
        <PasswordInput
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t('versioning.remote_token_placeholder')}
          className="h-9 text-sm"
        />
        <p className="text-[11px] text-muted-foreground leading-relaxed">{t('versioning.remote_token_hint')}</p>
      </div>
      {error && <GitErrorInline detail={error.raw} />}
      <div className="flex justify-end">
        <Button onClick={handleConnect} disabled={!canConnect || saving} className="gap-1.5">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <GitBranch size={14} />}
          {t('versioning.remote_connect')}
        </Button>
      </div>
    </div>
  )
}
