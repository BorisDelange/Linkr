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
import { Label } from '@/components/ui/label'
import { getGitCorsProxy, setGitCorsProxy, cloneRepoToZip, classifyCloneError } from '@/lib/git-clone'

interface ImportSourceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Accept filter for the file picker (default '.zip'). */
  accept?: string
  /**
   * Receives the chosen source as a File — either the uploaded file or a ZIP built from
   * a cloned git repo. The caller's existing import logic stays unchanged.
   */
  onImport: (file: File) => void | Promise<void>
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
  const [error, setError] = useState<string | null>(null)
  const [showProxyHelp, setShowProxyHelp] = useState(false)
  const [copied, setCopied] = useState(false)

  const PROXY_CMD = 'npm run dev:proxy'
  const copyCmd = async () => {
    try { await navigator.clipboard.writeText(PROXY_CMD); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
  }

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    onOpenChange(false)
    await onImport(file)
  }

  const repoName = (u: string) => (u.split('/').pop() || 'repo').replace(/\.git$/, '')

  const handleClone = async () => {
    if (!url.trim() || cloning) return
    setError(null)
    setCloning(true)
    try {
      const zip = await cloneRepoToZip({ url: url.trim(), branch: branch.trim() || 'main', token: token || undefined })
      const blob = await zip.generateAsync({ type: 'blob' })
      onOpenChange(false)
      await onImport(new File([blob], `${repoName(url)}.zip`, { type: 'application/zip' }))
    } catch (err) {
      console.error('[import] git clone failed:', err)
      const kind = classifyCloneError(err)
      const raw = err instanceof Error ? err.message : String(err)
      // Show the underlying message too — the generic hint alone hides the real cause.
      setError(`${t(`import_source.error_${kind}`)}${raw ? `\n(${raw})` : ''}`)
    } finally {
      setCloning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setError(null); onOpenChange(o) }}>
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

          {/* Upload ZIP */}
          <TabsContent value="upload" className="min-h-[230px] flex flex-col items-center justify-center gap-3 pt-3">
            <Upload size={28} className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground text-center max-w-xs">{t('import_source.upload_hint')}</p>
            <Button onClick={() => fileInputRef.current?.click()} className="gap-1.5">
              <Upload size={14} />
              {t('import_source.choose_file')}
            </Button>
            <input ref={fileInputRef} type="file" accept={accept} className="hidden" onChange={handleFile} />
          </TabsContent>

          {/* Clone from Git */}
          <TabsContent value="git" className="min-h-[230px] space-y-3 pt-3">
            <div className="space-y-2">
              <Label className="text-xs">{t('import_source.git_url')}</Label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://gitlab.com/group/repo.git" className="h-9 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label className="text-xs">{t('import_source.git_branch')}</Label>
                <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className="h-9 text-sm" />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">{t('import_source.git_token')}</Label>
                <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('import_source.git_token_ph')} className="h-9 text-sm" />
              </div>
            </div>
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
            {error && <p className="whitespace-pre-line text-[11px] text-destructive">{error}</p>}
            <div className="flex justify-end">
              <Button onClick={handleClone} disabled={!url.trim() || !proxy.trim() || cloning} className="gap-1.5">
                {cloning ? <Loader2 size={14} className="animate-spin" /> : <GitBranch size={14} />}
                {t('import_source.clone_import')}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
