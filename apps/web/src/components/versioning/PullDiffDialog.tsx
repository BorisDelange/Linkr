import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DiffEditor, type BeforeMount } from '@monaco-editor/react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { FileWarning } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'
import { linkrDark, linkrLight } from '@/components/editor/monaco-themes'
import { groupGitFiles } from '@/lib/git-file-meta'
import { changeTypeMeta } from './git-change-meta'
import { pullChangeType, type PullFile, type PullPlan } from '@/lib/pull-plan'
import type { PullDiffText } from '@/lib/concept-mapping/pull-diff'

interface PullDiffDialogProps {
  plan: PullPlan
  initialPath: string
  /** Build the two sides for a file — a projection of the plan, not a file diff. */
  buildDiff: (file: PullFile) => PullDiffText
  onClose: () => void
}

/**
 * Incoming-change viewer: the mirror of `GitDiffDialog`, with the sides swapped.
 *
 * Left is what we hold, right is what the remote would land — and both are built
 * from the merge plan, so what the user reads is exactly what ticking the row
 * applies (see lib/concept-mapping/pull-diff.ts).
 */
export function PullDiffDialog({ plan, initialPath, buildDiff, onClose }: PullDiffDialogProps) {
  const { t } = useTranslation()
  const darkMode = useAppStore((s) => s.darkMode)
  const [path, setPath] = useState(initialPath)

  const file = plan.files.find((f) => f.path === path) ?? plan.files[0]
  const diff = file ? buildDiff(file) : null

  const beforeMount: BeforeMount = useCallback((monaco) => {
    monaco.editor.defineTheme('linkr-dark', linkrDark)
    monaco.editor.defineTheme('linkr-light', linkrLight)
  }, [])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[85vh] w-[92vw] max-w-[1400px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1400px]">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 truncate font-mono text-sm">
            {path}
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-sans text-[10px] font-normal text-muted-foreground">
              {t('versioning.pull_diff_direction')}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1">
          <Allotment>
            <Allotment.Pane preferredSize={288} minSize={160} maxSize={560}>
              <div className="h-full overflow-y-auto overflow-x-hidden border-r">
                {groupGitFiles(plan.scope, plan.files, (f) => f.path).map((group) => (
                  <div key={group.category}>
                    <div className="sticky top-0 z-10 bg-muted/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                      {t(`versioning.file_cat_${group.category}`)}
                    </div>
                    <ul className="p-1">
                      {group.files.map((f) => {
                        const meta = changeTypeMeta(pullChangeType(f))
                        return (
                          <li key={f.path}>
                            <button
                              type="button"
                              onClick={() => setPath(f.path)}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                                f.path === path ? 'bg-muted' : 'hover:bg-muted/50',
                              )}
                            >
                              <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[9px] font-bold', meta.badgeClass)}>
                                {meta.letter}
                              </span>
                              <span className="truncate font-mono text-xs">{f.path}</span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </Allotment.Pane>

            <Allotment.Pane minSize={320}>
              {diff?.notice === 'whole_file' ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                  <FileWarning size={28} />
                  <p className="max-w-md text-sm">{t('versioning.pull_diff_whole_file')}</p>
                </div>
              ) : (
                <DiffEditor
                  key={path}
                  original={diff?.oldContent ?? ''}
                  modified={diff?.newContent ?? ''}
                  language={diff?.language ?? 'json'}
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
            </Allotment.Pane>
          </Allotment>
        </div>
      </DialogContent>
    </Dialog>
  )
}
