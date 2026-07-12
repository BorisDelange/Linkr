import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DiffEditor, type BeforeMount } from '@monaco-editor/react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { FileWarning, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'
import { useGitSyncStore } from '@/stores/git-sync-store'
import { linkrDark, linkrLight } from '@/components/editor/monaco-themes'
import { monacoLanguageFor } from '@/lib/monaco-language'
import { ChangeBadge } from './ChangeBadge'
import type { GitDiff, GitFileChange, GitScope } from '@/lib/api/git'

interface GitDiffDialogProps {
  scope: GitScope
  id: string
  branch: string
  files: GitFileChange[]
  initialPath: string
  selected: Set<string>
  onToggle: (path: string) => void
  onClose: () => void
}

/**
 * Full-size diff viewer: a file sidebar (with per-type colour + commit checkbox)
 * on the left, a Monaco side-by-side diff (syntax-highlighted, self-scrolling —
 * never overflows the modal) on the right. Oversized/binary files show a notice
 * instead of a diff so the UI stays responsive.
 */
export function GitDiffDialog({ scope, id, branch, files, initialPath, selected, onToggle, onClose }: GitDiffDialogProps) {
  const { t } = useTranslation()
  const darkMode = useAppStore((s) => s.darkMode)
  const getDiff = useGitSyncStore((s) => s.getDiff)
  const [path, setPath] = useState(initialPath)
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [loading, setLoading] = useState(false)
  // Cache diffs already fetched this session so switching back to a file is
  // instant (no rebuild/refetch). Keyed by path; scoped to this dialog instance.
  const cache = useRef<Map<string, GitDiff | null>>(new Map())

  useEffect(() => {
    let cancelled = false
    const cached = cache.current.get(path)
    if (cached !== undefined) {
      setDiff(cached)
      setLoading(false)
      return
    }
    setLoading(true)
    setDiff(null)
    void getDiff(scope, id, path, branch).then((d) => {
      cache.current.set(path, d)
      if (!cancelled) {
        setDiff(d)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [scope, id, path, branch, getDiff])

  const beforeMount: BeforeMount = useCallback((monaco) => {
    monaco.editor.defineTheme('linkr-dark', linkrDark)
    monaco.editor.defineTheme('linkr-light', linkrLight)
  }, [])

  const language = monacoLanguageFor(path)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[85vh] w-[92vw] max-w-[1400px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1400px]">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="truncate font-mono text-sm">{path}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1">
          <Allotment>
            {/* Resizable file sidebar — scrolls both ways so long paths read in full. */}
            <Allotment.Pane preferredSize={288} minSize={160} maxSize={560}>
              <div className="h-full overflow-auto border-r">
                <ul className="w-max min-w-full p-1">
                  {files.map((f) => {
                    const active = f.path === path
                    return (
                      <li key={f.path}>
                        <div
                          className={cn(
                            'flex items-center gap-2 rounded-md px-2 py-1.5',
                            active ? 'bg-muted' : 'hover:bg-muted/50',
                          )}
                        >
                          <Checkbox
                            checked={selected.has(f.path)}
                            onCheckedChange={() => onToggle(f.path)}
                            onClick={(e) => e.stopPropagation()}
                            className="shrink-0"
                          />
                          <button
                            type="button"
                            onClick={() => setPath(f.path)}
                            className="flex flex-1 items-center gap-2 text-left"
                          >
                            <ChangeBadge changeType={f.changeType} />
                            <span className="whitespace-nowrap font-mono text-xs">{f.path}</span>
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </Allotment.Pane>

            {/* Diff pane */}
            <Allotment.Pane minSize={320}>
              {loading ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  {t('versioning.sync_computing')}
                </div>
              ) : diff?.binary ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                  <FileWarning size={28} />
                  <p className="text-sm">{t('versioning.diff_binary')}</p>
                </div>
              ) : (
                <div className="flex h-full flex-col">
                  {diff?.truncated && (
                    <div className="flex shrink-0 items-center gap-1.5 border-b bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                      <FileWarning size={12} />
                      {t('versioning.diff_truncated')}
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
                    <DiffEditor
                      key={path}
                      original={diff?.oldContent ?? ''}
                      modified={diff?.newContent ?? ''}
                      language={language}
                      theme={darkMode ? 'linkr-dark' : 'linkr-light'}
                      beforeMount={beforeMount}
                      options={{
                        readOnly: true,
                        renderSideBySide: true,
                        wordWrap: 'on',
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        fontSize: 12,
                        automaticLayout: true,
                      }}
                    />
                  </div>
                </div>
              )}
            </Allotment.Pane>
          </Allotment>
        </div>
      </DialogContent>
    </Dialog>
  )
}
