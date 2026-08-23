import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, GitBranch, Loader2, FileArchive, Store } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Label } from '@/components/ui/label'
import { cleanGitUrl } from '@/lib/git-clone'
import { gitCloneToZip } from '@/lib/api/git'
import { isServerMode } from '@/lib/api-client'
import { ServerModeNotice } from '@/components/ui/server-mode-notice'
import { GitErrorInline } from '@/components/versioning/GitErrorInline'
import { ImportCatalogTab } from '@/components/ui/import-catalog-tab'
import { CatalogInstallOutcome } from '@/features/catalog/CatalogInstallDialog'
import { useCatalogInstall } from '@/features/catalog/use-catalog-install'
import { catalogTypeForScope } from '@/lib/catalog/scope'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { GitScope } from '@/lib/api/git'

/** Git link captured during an import-from-git, so the caller can pre-configure
 *  the imported entity's Versioning page with the same repo. */
export interface ImportGitRemote {
  url: string
  branch: string
  authToken?: string
  /** HEAD oid of the clone (server mode) — the base to anchor sync state to. */
  syncedOid?: string
}

interface ImportSourceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Accept filter for the file picker (default '.zip'). */
  accept?: string
  /**
   * Receives the chosen source as a File — either the uploaded file or a ZIP built from
   * a cloned git repo. `gitRemote` is set when the source was cloned from git, so the
   * caller can link the imported entity to that repo. The existing import path is unchanged.
   */
  onImport: (file: File, gitRemote?: ImportGitRemote) => void | Promise<void>
  /** Hide the "clone from Git" tab, leaving only ZIP upload. Used when a git remote
   *  is already linked (there, pulling — not re-importing — is the git path). */
  hideGit?: boolean
  /**
   * Sync scope of the page that opened the dialog. When it maps to a catalog entry type,
   * a third tab lists that type's published entries and installs them in place. Omit it
   * (or pass a scope the catalog does not publish) to keep the two-source dialog.
   */
  scope?: GitScope
  /** Called after a catalog install, so the caller can refresh its list. */
  onCatalogInstalled?: () => void
}

/**
 * Import dialog: upload a ZIP, clone a Git repository, or install from the community
 * catalog. Git clone runs SERVER-SIDE only: the backend clones the repo and returns a
 * ZIP, which flows through the same import path as an upload. In client-only (WASM)
 * mode the git tab shows a "not available" notice — the in-browser CORS-proxy
 * clone was dropped (too fragile for too little value). The catalog tab appears only
 * when `scope` names a type the catalog publishes.
 */
export function ImportSourceDialog({
  open,
  onOpenChange,
  accept = '.zip',
  onImport,
  hideGit = false,
  scope,
  onCatalogInstalled,
}: ImportSourceDialogProps) {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [token, setToken] = useState('')
  const [cloning, setCloning] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)  // full raw error, shown via GitErrorInline's tooltip
  const [dragActive, setDragActive] = useState(false)

  // Git clone is server-side only.
  const serverMode = isServerMode()

  const catalogType = catalogTypeForScope(scope)
  /** Tracked only to widen the dialog on the catalog tab, whose cards need the room. */
  const [tab, setTab] = useState('upload')
  const language = useAppStore((s) => s.language)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  /** Re-read what is installed after each install, exactly as the Catalog page does. */
  const [installedNonce, setInstalledNonce] = useState(0)
  const afterInstall = useCallback(() => {
    setInstalledNonce((n) => n + 1)
    onCatalogInstalled?.()
  }, [onCatalogInstalled])
  const catalogInstall = useCatalogInstall(activeWorkspaceId ?? '', afterInstall)

  const submitFile = async (file: File) => {
    // Keep the modal open with a blocking loader until the import (upload + parse
    // + persist, which can be long for a big source file) actually finishes —
    // closing first made it look done while it was still uploading in the
    // background, so the new project appeared only after a manual reload.
    setError(null)
    setImporting(true)
    try {
      await onImport(file)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) await submitFile(file)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files[0]
    if (file) await submitFile(file)
  }

  const repoName = (u: string) => (u.split('/').pop() || 'repo').replace(/\.git$/, '')

  const handleClone = async () => {
    if (!url.trim() || cloning) return
    setError(null)
    setCloning(true)
    try {
      // Users often paste a repo web-page URL (…/-/tree/main?ref_type=heads); clean
      // it to the bare clone URL so both the clone and the stored link work.
      const cleanUrl = cleanGitUrl(url.trim())
      const cloned = await gitCloneToZip(cleanUrl, branch.trim() || 'main', token || undefined)
      const blob = cloned.blob
      const syncedOid = cloned.oid ?? undefined
      const gitRemote = { url: cleanUrl, branch: branch.trim() || 'main', authToken: token || undefined, syncedOid }
      // Keep the modal open (with the loader) until the import actually finishes —
      // writing entities, scores and refreshing the list. Closing first unmounted
      // the dialog mid-import, so suggestions weren't persisted and the list stayed
      // stale. Only close on success; keep it open to show any error.
      setImporting(true)
      await onImport(new File([blob], `${repoName(cleanUrl)}.zip`, { type: 'application/zip' }), gitRemote)
      onOpenChange(false)
    } catch (err) {
      console.error('[import] git clone/import failed:', err)
      // One generic line + the full raw error in an info tooltip (GitErrorInline),
      // consistent with the versioning surfaces — no per-case message mapping.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCloning(false)
      setImporting(false)
    }
  }

  const busy = importing || cloning

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (busy) return  // don't let the modal close mid-import
      if (!o) setError(null)
      onOpenChange(o)
    }}>
      {/* The catalog tab shows the same cards as the Catalog page, two to a row; the
          default lg modal is far too narrow for them, so the dialog grows on that tab
          only and the other two keep their compact size. */}
      <DialogContent className={tab === 'catalog' ? 'sm:max-w-4xl' : undefined}>
        <DialogHeader>
          <DialogTitle>{t('import_source.title')}</DialogTitle>
          <DialogDescription>{t('import_source.description')}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full">
            <TabsTrigger value="upload" className="flex-1 gap-1.5">
              <FileArchive size={14} />
              {t('import_source.tab_upload')}
            </TabsTrigger>
            {!hideGit && (
              <TabsTrigger value="git" className="flex-1 gap-1.5">
                <GitBranch size={14} />
                {t('import_source.tab_git')}
              </TabsTrigger>
            )}
            {catalogType && (
              <TabsTrigger value="catalog" className="flex-1 gap-1.5">
                <Store size={14} />
                {t('import_source.tab_catalog')}
              </TabsTrigger>
            )}
          </TabsList>

          {/* Upload ZIP — drag-and-drop zone (matches the dataset upload dialog) */}
          <TabsContent value="upload" className="min-h-[230px] pt-3">
            {importing ? (
              <div className="flex h-[214px] flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/25 p-8">
                <Loader2 size={32} className="animate-spin text-primary" />
                <p className="mt-3 text-sm text-muted-foreground text-center">{t('import_source.importing')}</p>
              </div>
            ) : (
              <div
                className={`flex h-[214px] flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors cursor-pointer ${
                  dragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50'
                }`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
              >
                <Upload size={32} className="text-muted-foreground/50" />
                <p className="mt-3 text-sm text-muted-foreground text-center">{t('import_source.drag_drop_or')}</p>
                <p className="mt-2 text-[10px] text-muted-foreground">{t('import_source.upload_hint')}</p>
                <input ref={fileInputRef} type="file" accept={accept} className="hidden" onChange={handleFile} />
              </div>
            )}
          </TabsContent>

          {/* Clone from Git — server-side only; hidden when a remote is already linked */}
          {!hideGit && (
          <TabsContent value="git" className="min-h-[230px] space-y-3 pt-3">
            {!serverMode ? (
              <ServerModeNotice inline className="mx-auto" />
            ) : (
              <>
                <div className="space-y-2">
                  <Label>{t('import_source.git_url')}</Label>
                  <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://gitlab.com/group/repo.git" className="h-9 text-sm" />
                </div>
                <div className="space-y-2">
                  <Label>{t('import_source.git_branch')}</Label>
                  <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className="h-9 text-sm" />
                </div>
                <div className="space-y-2">
                  <Label>{t('import_source.git_token')}</Label>
                  <PasswordInput value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('import_source.git_token_ph')} className="h-9 text-sm" />
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">{t('import_source.private_repo_hint')}</p>
                {error && <GitErrorInline detail={error} />}
                <div className="flex items-center justify-end gap-2">
                  {importing && <span className="text-xs text-muted-foreground">{t('import_source.importing')}</span>}
                  <Button onClick={handleClone} disabled={!url.trim() || busy} className="gap-1.5">
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <GitBranch size={14} />}
                    {t('import_source.clone_import')}
                  </Button>
                </div>
              </>
            )}
          </TabsContent>
          )}

          {/* Install from the community catalog — the third import source. */}
          {catalogType && (
            <TabsContent value="catalog" className="pt-3">
              <ImportCatalogTab
                type={catalogType}
                workspaceId={activeWorkspaceId ?? ''}
                install={catalogInstall}
                language={language}
                installedNonce={installedNonce}
                onClose={() => onOpenChange(false)}
              />
            </TabsContent>
          )}
        </Tabs>

        {/* The install's own confirm / conflict / failure dialogs, same as on the
            Catalog page. Rendered inside this dialog so they stack above it. */}
        {catalogType && <CatalogInstallOutcome install={catalogInstall} language={language} />}
      </DialogContent>
    </Dialog>
  )
}
