import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DiffEditor, type BeforeMount } from '@monaco-editor/react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { FileWarning, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'
import { useGitSyncStore } from '@/stores/git-sync-store'
import { defineLinkrThemes } from '@/components/editor/monaco-themes'
import { monacoLanguageFor } from '@/lib/monaco-language'
import { SectionLabel } from '@/components/ui/section-label'
import { groupGitFiles } from '@/lib/git-file-meta'
import { ChangeBadge } from './ChangeBadge'
import { DiffTooLargeNotice } from './DiffTooLargeNotice'
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
  const getRawSides = useGitSyncStore((s) => s.getRawSides)
  const [path, setPath] = useState(initialPath)
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    // getDiff caches per file in the store (survives closing/reopening this dialog on
    // the same entity), so switching back to a file it already showed resolves instantly.
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
    defineLinkrThemes(monaco)
  }, [])

  const language = monacoLanguageFor(path)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* The close button is positioned for a p-6 dialog; this one is flush, and
          its header bar is 40px tall (py-3 + a 16px-line title), so the
          default offset left the X sitting low. Centre it on the bar: (40-28)/2. */}
      <DialogContent className="flex h-[85vh] w-[92vw] max-w-[1400px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1400px] [&>[data-slot=dialog-close]]:top-1.5">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          {/* leading-4 over the primitive's leading-none: a path is monospace and
              truncated, and a line box the exact height of the text clipped the
              descenders (the j of .json). Keeps the bar at 40px either way. */}
          <DialogTitle className="truncate font-mono text-sm leading-4">{path}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1">
          <Allotment>
            {/* Resizable file sidebar — long paths truncate with … (full path on
                hover) so the pane never scrolls horizontally. */}
            <Allotment.Pane preferredSize={288} minSize={160} maxSize={560}>
              <div className="h-full overflow-y-auto overflow-x-hidden border-r">
                {/* Grouped + ordered by category, mirroring the sync panel's list. */}
                <TooltipProvider delayDuration={300}>
                  {groupGitFiles(scope, files, (f) => f.path).map((group) => (
                    <div key={group.category}>
                      <SectionLabel className="sticky top-0 z-10 bg-muted/60 px-3 py-1 font-semibold tracking-wide backdrop-blur">
                        {t(`versioning.file_cat_${group.category}`)}
                      </SectionLabel>
                      <ul className="p-1">
                        {group.files.map((f) => {
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
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      onClick={() => setPath(f.path)}
                                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                    >
                                      <ChangeBadge changeType={f.changeType} />
                                      <span className="truncate font-mono text-xs">{f.path}</span>
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="right" className="max-w-md font-mono">
                                    {f.path}
                                  </TooltipContent>
                                </Tooltip>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  ))}
                </TooltipProvider>
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
              ) : diff?.truncationMode === 'too_large' ? (
                <DiffTooLargeNotice path={path} fetchSides={() => getRawSides(scope, id, path, branch)} />
              ) : diff?.truncationMode === 'eol_only' || diff?.truncationMode === 'no_content_change' ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                  <FileWarning size={28} />
                  <p className="max-w-md whitespace-pre-line text-sm">
                    {diff.truncationMode === 'eol_only'
                      ? t('versioning.diff_eol_only')
                      : diff.oldPath
                        // Same bytes under a new name: say so, rather than the generic
                        // "flagged modified but unchanged" message, which reads as a puzzle.
                        ? t('versioning.diff_renamed_only', { path: diff.oldPath })
                        : t('versioning.diff_no_content_change')}
                  </p>
                </div>
              ) : (
                <div className="flex h-full flex-col">
                  {diff?.oldPath ? (
                    <div className="flex shrink-0 items-center gap-1.5 border-b bg-violet-500/10 px-3 py-1.5 text-xs text-violet-700 dark:text-violet-400">
                      <FileWarning size={12} />
                      {t('versioning.diff_renamed_from', { path: diff.oldPath })}
                    </div>
                  ) : null}
                  {diff?.truncationMode === 'hunks' ? (
                    <div className="flex shrink-0 items-center gap-1.5 border-b bg-sky-500/10 px-3 py-1.5 text-xs text-sky-700 dark:text-sky-400">
                      <FileWarning size={12} />
                      {diff.truncated ? t('versioning.diff_hunks_capped') : t('versioning.diff_hunks')}
                    </div>
                  ) : diff?.truncated ? (
                    <div className="flex shrink-0 items-center gap-1.5 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                      <FileWarning size={12} />
                      {t('versioning.diff_truncated')}
                    </div>
                  ) : null}
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
