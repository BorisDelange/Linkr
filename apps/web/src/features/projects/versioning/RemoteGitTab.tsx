import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, ArrowUpFromLine, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useVersioningStore } from '@/stores/versioning-store'

export function RemoteGitTab() {
  const { t } = useTranslation()
  const { remoteConfig, setRemoteConfig, clearRemoteConfig } = useVersioningStore()

  const [url, setUrl] = useState(remoteConfig?.url ?? '')
  const [branch, setBranch] = useState(remoteConfig?.branch ?? 'main')
  const [token, setToken] = useState(remoteConfig?.authToken ?? '')

  const isConnected = remoteConfig !== null
  const canConnect = url.trim().length > 0

  const handleConnect = () => {
    if (!canConnect) return
    setRemoteConfig({ url: url.trim(), branch: branch.trim() || 'main', authToken: token || undefined })
  }

  const handleDisconnect = () => {
    clearRemoteConfig()
    setUrl('')
    setBranch('main')
    setToken('')
  }

  return (
    <>
      {/* Repository config */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('versioning.remote_repository')}</CardTitle>
          <CardDescription>{t('versioning.remote_repository_description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs">{t('versioning.remote_url')}</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('versioning.remote_url_placeholder')}
              disabled={isConnected}
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
                disabled={isConnected}
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
                disabled={isConnected}
                className="h-9 text-sm"
              />
            </div>
          </div>
          {isConnected ? (
            <Button variant="outline" size="sm" onClick={handleDisconnect}>
              {t('versioning.remote_disconnect')}
            </Button>
          ) : (
            <Button size="sm" onClick={handleConnect} disabled={!canConnect}>
              {t('versioning.remote_connect')}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Sync */}
      {isConnected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('versioning.remote_sync')}</CardTitle>
            <CardDescription>{t('versioning.remote_sync_description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <Info size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {t('versioning.remote_requires_backend')}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled className="gap-1.5">
                <ArrowDownToLine size={14} />
                {t('versioning.remote_pull')}
              </Button>
              <Button variant="outline" size="sm" disabled className="gap-1.5">
                <ArrowUpFromLine size={14} />
                {t('versioning.remote_push')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  )
}
