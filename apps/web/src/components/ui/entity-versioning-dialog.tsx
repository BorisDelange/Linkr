import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, GitBranch, Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { GitRemoteConfig } from '@/types'

interface EntityVersioningDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Which tab to show first. 'export' or 'git'. */
  initialTab?: 'export' | 'git'
  /** Whether the export supports an "include data" toggle (false hides it). */
  supportsIncludeData?: boolean
  /** Run the per-entity export. */
  onExport: (options: { includeDataFiles: boolean }) => void | Promise<void>
  /** Current git link of the entity, or null when unlinked. */
  gitRemote: GitRemoteConfig | null
  /** Persist a git link (or null to unlink) on the entity. */
  onSaveGitRemote: (config: GitRemoteConfig | null) => void | Promise<void>
}

/**
 * Unified per-entity versioning dialog: Export + Git repository link.
 * Reused by all linkable entities (projects, mapping projects, SQL collections, ETL pipelines).
 */
export function EntityVersioningDialog({
  open,
  onOpenChange,
  initialTab = 'export',
  supportsIncludeData = true,
  onExport,
  gitRemote,
  onSaveGitRemote,
}: EntityVersioningDialogProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'export' | 'git'>(initialTab)
  const [includeData, setIncludeData] = useState(false)

  // The dialog is mounted fresh each time it opens (parent gates on a non-null target),
  // so these initializers capture the entity's current link without a re-seed effect.
  const [url, setUrl] = useState(gitRemote?.url ?? '')
  const [branch, setBranch] = useState(gitRemote?.branch ?? 'main')
  const [token, setToken] = useState(gitRemote?.authToken ?? '')

  // The dialog owns the link state after mount so it reflects connect/disconnect
  // immediately without depending on the parent re-passing a fresh prop.
  const [linked, setLinked] = useState(!!gitRemote?.url)
  const [saving, setSaving] = useState(false)
  // Brief "saved" confirmation shown on the button after a successful connect.
  const [justSaved, setJustSaved] = useState(false)

  const canConnect = url.trim().length > 0

  const handleExport = async () => {
    await onExport({ includeDataFiles: includeData })
    onOpenChange(false)
  }

  const handleConnect = async () => {
    if (!canConnect || saving) return
    setSaving(true)
    try {
      await onSaveGitRemote({ url: url.trim(), branch: branch.trim() || 'main', authToken: token || undefined })
      setLinked(true)
      // Flash a confirmation, then settle into the linked (Disconnect) state.
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
      await onSaveGitRemote(null)
      setLinked(false)
      setUrl('')
      setBranch('main')
      setToken('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('app_versioning.entity_versioning_title')}</DialogTitle>
          <DialogDescription>{t('app_versioning.entity_versioning_description')}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'export' | 'git')}>
          <TabsList className="w-full">
            <TabsTrigger value="export" className="flex-1 gap-1.5">
              <Download size={14} />
              {t('versioning.tab_export')}
            </TabsTrigger>
            <TabsTrigger value="git" className="flex-1 gap-1.5">
              <GitBranch size={14} />
              {t('app_versioning.tab_git_repository')}
            </TabsTrigger>
          </TabsList>

          {/* --- Export tab --- */}
          <TabsContent value="export" className="space-y-3 pt-3">
            {linked ? (
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('app_versioning.entity_export_git_linked_hint')}
              </p>
            ) : supportsIncludeData ? (
              <>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="entity-export-include-data"
                    checked={includeData}
                    onCheckedChange={(v) => setIncludeData(v === true)}
                  />
                  <Label htmlFor="entity-export-include-data" className="text-sm font-normal cursor-pointer">
                    {t('versioning.export_include_data')}
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('versioning.export_include_data_hint')}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{t('versioning.export_description')}</p>
            )}
            <div className="flex justify-end">
              <Button onClick={handleExport} className="gap-1.5">
                <Download size={14} />
                {t('versioning.export_download')}
              </Button>
            </div>
          </TabsContent>

          {/* --- Git repository tab --- */}
          <TabsContent value="git" className="space-y-4 pt-3">
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
                  disabled={isLinked}
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
                  disabled={isLinked}
                  className="h-9 text-sm"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('app_versioning.entity_git_link_hint')}
            </p>
            {justSaved ? (
              <Button size="sm" variant="outline" disabled className="gap-1.5 text-green-600 border-green-600/40">
                <Check size={14} />
                {t('app_versioning.remote_connected')}
              </Button>
            ) : linked ? (
              <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={saving}>
                {t('versioning.remote_disconnect')}
              </Button>
            ) : (
              <Button size="sm" onClick={handleConnect} disabled={!canConnect || saving}>
                {t('versioning.remote_connect')}
              </Button>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
