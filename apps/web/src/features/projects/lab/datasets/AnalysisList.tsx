import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, Pencil, Trash2, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { InlineRenameField } from '@/components/InlineRenameField'
import { useDatasetStore } from '@/stores/dataset-store'
import { getPlugin } from '@/lib/plugins/registry'
import type { AnalysisLanguage } from '@/types'

const LANG_BADGE: Record<string, { label: string; color: string }> = {
  python: { label: 'PY', color: 'text-yellow-500 bg-yellow-500/10' },
  r: { label: 'R', color: 'text-blue-500 bg-blue-500/10' },
  sql: { label: 'SQL', color: 'text-emerald-500 bg-emerald-500/10' },
}

function LanguageBadge({ language, type }: { language?: AnalysisLanguage | string; type: string }) {
  let lang = language
  if (!lang) {
    const plugin = getPlugin(type)
    if (plugin && plugin.manifest.languages.length > 0) lang = plugin.manifest.languages[0]
  }
  if (!lang) return null
  const badge = LANG_BADGE[lang]
  if (!badge) return null
  return (
    <span className={cn('shrink-0 rounded px-1 py-px text-[9px] font-medium leading-none', badge.color)}>
      {badge.label}
    </span>
  )
}

/**
 * The dataset analyses sidebar list. Self-contained (owns rename + delete-confirm
 * state and reads the store directly) so interacting with it doesn't re-render the
 * whole DatasetsPage — which was making right-click → Rename feel laggy by
 * re-rendering the dataset table alongside it.
 */
export function AnalysisList({ selectedFileId }: { selectedFileId: string | null }) {
  const { t } = useTranslation()
  const analyses = useDatasetStore((s) => s.analyses)
  const selectedAnalysisId = useDatasetStore((s) => s.selectedAnalysisId)
  const selectAnalysis = useDatasetStore((s) => s.selectAnalysis)
  const renameAnalysis = useDatasetStore((s) => s.renameAnalysis)
  const deleteAnalysis = useDatasetStore((s) => s.deleteAnalysis)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  return (
    <ScrollArea className="h-full min-h-0 flex-1">
      {!selectedFileId ? (
        <div className="flex items-center justify-center p-4 text-center">
          <p className="text-xs text-muted-foreground">{t('datasets.no_analyses_select_dataset')}</p>
        </div>
      ) : analyses.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-4 text-center">
          <p className="text-xs text-muted-foreground">{t('datasets.no_analyses')}</p>
        </div>
      ) : (
        <div className="py-1">
          {analyses.map((analysis) => {
            const isActive = analysis.id === selectedAnalysisId
            return (
              <ContextMenu key={analysis.id}>
                <ContextMenuTrigger asChild>
                  {renamingId === analysis.id ? (
                    // Plain div (not a <button>) so the nested input keeps focus/selection.
                    <div className="flex w-full items-center gap-1.5 px-3 py-1 text-xs">
                      <BarChart3 size={14} className="shrink-0 text-violet-500" />
                      <InlineRenameField
                        initialValue={analysis.name}
                        onSubmit={(name) => { renameAnalysis(analysis.id, name); setRenamingId(null) }}
                        onCancel={() => setRenamingId(null)}
                        hasClash={(candidate) =>
                          analyses.some((a) => a.id !== analysis.id && a.datasetFileId === analysis.datasetFileId && a.name.toLowerCase() === candidate.toLowerCase())
                        }
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => selectAnalysis(isActive ? null : analysis.id)}
                      onDoubleClick={() => setRenamingId(analysis.id)}
                      className={cn(
                        'group flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs transition-colors hover:bg-accent/50',
                        isActive && 'bg-accent text-accent-foreground',
                      )}
                    >
                      <BarChart3 size={14} className="shrink-0 text-violet-500" />
                      <span className="truncate">{analysis.name}</span>
                      <LanguageBadge language={analysis.config.language as string | undefined} type={analysis.type} />
                      {!!analysis.config.autoRun && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Zap size={10} className="shrink-0 text-amber-500 fill-amber-500" />
                          </TooltipTrigger>
                          <TooltipContent side="right">{t('datasets.analysis_auto_run')}</TooltipContent>
                        </Tooltip>
                      )}
                    </button>
                  )}
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => setRenamingId(analysis.id)}>
                    <Pencil size={14} />
                    {t('datasets.rename')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => setDeleteId(analysis.id)}>
                    <Trash2 size={14} />
                    {t('datasets.delete')}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      )}

      <AlertDialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('datasets.delete_analysis_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('datasets.delete_analysis_description', { name: analyses.find((a) => a.id === deleteId)?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => { if (deleteId) deleteAnalysis(deleteId); setDeleteId(null) }}
            >
              {t('datasets.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  )
}
