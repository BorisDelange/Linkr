import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
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
 * Git repository link form (URL / branch / token + connect/disconnect), shared by the
 * versioning page and the per-entity dialog. Owns its own state so the connect/disconnect
 * feedback works without the parent re-passing a fresh prop.
 */
export function GitRepositoryTab({ gitRemote, onSave, syncScope, syncId }: GitRepositoryTabProps) {
  const { t } = useTranslation()
  const [url, setUrl] = useState(gitRemote?.url ?? '')
  const [branch, setBranch] = useState(gitRemote?.branch ?? 'main')
  const [token, setToken] = useState(gitRemote?.authToken ?? '')
  const [linked, setLinked] = useState(!!gitRemote?.url)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  const canConnect = url.trim().length > 0

  const handleConnect = async () => {
    if (!canConnect || saving) return
    setSaving(true)
    try {
      await onSave({ url: url.trim(), branch: branch.trim() || 'main', authToken: token || undefined })
      setLinked(true)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 1800)
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
      setBranch('main')
      setToken('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs">{t('versioning.remote_url')}</Label>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('versioning.remote_url_placeholder')}
          disabled={linked}
          className="h-9 text-sm"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-xs">{t('versioning.remote_branch')}</Label>
          <Input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
            disabled={linked}
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
            disabled={linked}
            className="h-9 text-sm"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {t('app_versioning.entity_git_link_hint')}
      </p>
      <div className="flex justify-end">
        {justSaved ? (
          <Button variant="outline" disabled className="gap-1.5 text-muted-foreground">
            <Check size={14} className="text-primary" />
            {t('app_versioning.remote_connected')}
          </Button>
        ) : linked ? (
          <Button variant="outline" onClick={handleDisconnect} disabled={saving}>
            {t('versioning.remote_disconnect')}
          </Button>
        ) : (
          <Button onClick={handleConnect} disabled={!canConnect || saving}>
            {t('versioning.remote_connect')}
          </Button>
        )}
      </div>

      {linked && isServerMode() && syncScope && syncId && (
        <GitSyncPanel scope={syncScope} id={syncId} defaultBranch={branch || 'main'} />
      )}
    </div>
  )
}
