import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, GitBranch, Loader2, FileArchive, ChevronRight, Copy, Check } from 'lucide-react'
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
import { getGitCorsProxy, setGitCorsProxy, cloneRepoToZip, cleanGitUrl } from '@/lib/git-clone'
import { gitCloneToZip } from '@/lib/api/git'
import { isServerMode } from '@/lib/api-client'
import { GitErrorInline } from '@/components/versioning/GitErrorInline'

/** Git link captured during an import-from-git, so the caller can pre-configure
 *  the imported entity's Versioning page with the same repo. */
export interface ImportGitRemote {
  url: string
  branch: string
  authToken?: string
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
}

/**
 * Two-source import dialog: upload a ZIP, or clone a Git repository.
 * The git tab clones the repo in-browser (needs a CORS proxy) and hands the result
 * to `onImport` as a ZIP File, so it flows through the same import path as an upload.
 */
export function ImportSourceDialog({ open, onOpenChange, accept = '.zip', onImport }: ImportSourceDialogProps) {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [token, setToken] = useState('')
  const [proxy, setProxy] = useState(() => getGitCorsProxy())
  const [cloning, setCloning] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)  // full raw error, shown via GitErrorInline's tooltip
  const [showProxyHelp, setShowProxyHelp] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  // In server mode the backend clones the repo (no in-browser CORS proxy needed);
  // the proxy UI + isomorphic-git path only apply to local/WASM mode.
  const serverMode = isServerMode()

  const PROXY_CMD = 'npm run dev:proxy'
  const copyCmd = async () => {
    try { await navigator.clipboard.writeText(PROXY_CMD); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
  }

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
      let blob: Blob
      if (serverMode) {
        blob = await gitCloneToZip(cleanUrl, branch.trim() || 'main', token || undefined)
      } else {
        const zip = await cloneRepoToZip({ url: cleanUrl, branch: branch.trim() || 'main', token: token || undefined })
        blob = await zip.generateAsync({ type: 'blob' })
      }
      const gitRemote = { url: cleanUrl, branch: branch.trim() || 'main', authToken: token || undefined }
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('import_source.title')}</DialogTitle>
          <DialogDescription>{t('import_source.description')}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="upload">
          <TabsList className="w-full">
            <TabsTrigger value="upload" className="flex-1 gap-1.5">
              <FileArchive size={14} />
              {t('import_source.tab_upload')}
            </TabsTrigger>
            <TabsTrigger value="git" className="flex-1 gap-1.5">
              <GitBranch size={14} />
              {t('import_source.tab_git')}
            </TabsTrigger>
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

          {/* Clone from Git */}
          <TabsContent value="git" className="min-h-[230px] space-y-3 pt-3">
            <div className="space-y-2">
              <Label className="text-xs">{t('import_source.git_url')}</Label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://gitlab.com/group/repo.git" className="h-9 text-sm" />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">{t('import_source.git_branch')}</Label>
              <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className="h-9 text-sm" />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">{t('import_source.git_token')}</Label>
              <PasswordInput value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('import_source.git_token_ph')} className="h-9 text-sm" />
            </div>
            {serverMode ? (
              <p className="text-[10px] text-muted-foreground leading-relaxed">{t('import_source.private_repo_hint')}</p>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">{t('import_source.cors_proxy')}</Label>
                <Input value={proxy} onChange={(e) => { setProxy(e.target.value); setGitCorsProxy(e.target.value) }} placeholder="https://cors.isomorphic-git.org" className="h-8 text-xs" />
                <p className="text-[10px] text-muted-foreground leading-relaxed">{t('import_source.cors_hint')}</p>
                <button type="button" onClick={() => setShowProxyHelp(v => !v)} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
                  <ChevronRight size={11} className={showProxyHelp ? 'rotate-90 transition-transform' : 'transition-transform'} />
                  {t('import_source.run_local_proxy')}
                </button>
                {showProxyHelp && (
                  <div className="space-y-1.5 rounded-md border border-border bg-muted/40 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <code className="truncate text-[10px]">{PROXY_CMD}</code>
                      <Button size="icon-sm" variant="ghost" className="h-6 w-6 shrink-0" onClick={copyCmd}>
                        {copied ? <Check size={12} className="text-primary" /> : <Copy size={12} />}
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">{t('import_source.run_local_proxy_hint')}</p>
                  </div>
                )}
              </div>
            )}
            {error && <GitErrorInline detail={error} />}
            <div className="flex items-center justify-end gap-2">
              {importing && <span className="text-xs text-muted-foreground">{t('import_source.importing')}</span>}
              <Button onClick={handleClone} disabled={!url.trim() || (!serverMode && !proxy.trim()) || busy} className="gap-1.5">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <GitBranch size={14} />}
                {t('import_source.clone_import')}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
