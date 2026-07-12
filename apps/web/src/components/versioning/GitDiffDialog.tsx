import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DiffEditor, type BeforeMount } from '@monaco-editor/react'
import { FileWarning, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'
import { useGitSyncStore } from '@/stores/git-sync-store'
import { linkrDark, linkrLight } from '@/components/editor/monaco-themes'
import { monacoLanguageFor } from '@/lib/monaco-language'
import { changeTypeMeta } from './git-change-meta'
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

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setDiff(null)
    void getDiff(scope, id, path, branch).then((d) => {
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

        <div className="flex min-h-0 flex-1">
          {/* File sidebar */}
          <ScrollArea className="w-72 shrink-0 border-r">
            <ul className="p-1">
              {files.map((f) => {
                const meta = changeTypeMeta(f.changeType)
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
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span
                          className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[10px] font-bold', meta.badgeClass)}
                          title={t(meta.labelKey)}
                        >
                          {meta.letter}
                        </span>
                        <span className="truncate font-mono text-xs" title={f.path}>
                          {f.path}
                        </span>
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </ScrollArea>

          {/* Diff pane */}
          <div className="min-w-0 flex-1">
            {loading ? (
              <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                {t('versioning.sync_computing')}
              </div>
            ) : diff?.binary || diff?.tooLarge ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                <FileWarning size={28} />
                <p className="text-sm">{t(diff.binary ? 'versioning.diff_binary' : 'versioning.diff_too_large')}</p>
              </div>
            ) : (
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
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
