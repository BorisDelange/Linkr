import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, Pencil, Plus, Search, Trash2, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { GatedButton } from '@/components/ui/gated-button'
import { Input } from '@/components/ui/input'
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
export function AnalysisList({
  selectedFileId,
  canCreate,
  onCreate,
  createDisabledReason,
}: {
  selectedFileId: string | null
  canCreate: boolean
  onCreate: () => void
  createDisabledReason: string
}) {
  const { t } = useTranslation()
  const analyses = useDatasetStore((s) => s.analyses)
  const selectedAnalysisId = useDatasetStore((s) => s.selectedAnalysisId)
  const selectAnalysis = useDatasetStore((s) => s.selectAnalysis)
  const renameAnalysis = useDatasetStore((s) => s.renameAnalysis)
  const deleteAnalysis = useDatasetStore((s) => s.deleteAnalysis)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return analyses
    return analyses.filter((a) => a.name.toLowerCase().includes(q))
  }, [analyses, query])

  // Closing search clears the query: leaving a filter applied behind a hidden
  // field would silently hide analyses with no visible reason why.
  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      if (open) setQuery('')
      return !open
    })
  }, [])

  /** Move the selection by one, staying within the filtered list. */
  const step = useCallback(
    (delta: number) => {
      if (visible.length === 0) return
      const at = visible.findIndex((a) => a.id === selectedAnalysisId)
      // Nothing selected yet: Down enters at the top, Up at the bottom.
      const next = at === -1
        ? (delta > 0 ? 0 : visible.length - 1)
        : Math.min(visible.length - 1, Math.max(0, at + delta))
      selectAnalysis(visible[next].id)
      listRef.current
        ?.querySelector(`[data-analysis-id="${visible[next].id}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    },
    [visible, selectedAnalysisId, selectAnalysis],
  )

  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Renaming owns the keyboard while its input is open.
      if (renamingId) return
      if (e.key === 'ArrowDown') { e.preventDefault(); step(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
    },
    [renamingId, step],
  )

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onListKeyDown}>
      {/* Analyses header bar */}
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {t('datasets.analyses')}
        </span>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={toggleSearch}
                // Kept at the hover shade while open, so the toggle reads as ON
                // even when the pointer is elsewhere.
                className={cn(searchOpen && 'bg-accent text-accent-foreground')}
                aria-pressed={searchOpen}
                aria-label={t('datasets.search_analyses')}
              >
                <Search size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('datasets.search_analyses')}</TooltipContent>
          </Tooltip>
          {canCreate ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onCreate}
                  aria-label={t('datasets.new_analysis')}
                >
                  <Plus size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('datasets.new_analysis')}</TooltipContent>
            </Tooltip>
          ) : (
            /* GatedButton, not a plain disabled Button: a disabled element
               emits no pointer events, so its own tooltip never opens —
               and greyed-out is exactly when the reason needs explaining. */
            <GatedButton
              allowed={false}
              notAllowedReason={createDisabledReason}
              variant="ghost"
              size="icon-xs"
              aria-label={t('datasets.new_analysis')}
            >
              <Plus size={14} />
            </GatedButton>
          )}
        </div>
      </div>

      {searchOpen && (
        <div className="border-b p-1.5">
          <SearchField value={query} onChange={setQuery} onClose={toggleSearch} onStep={step} />
        </div>
      )}

    <ScrollArea className="h-full min-h-0 flex-1">
      {!selectedFileId ? (
        <div className="flex items-center justify-center p-4 text-center">
          <p className="text-xs text-muted-foreground">{t('datasets.no_analyses_select_dataset')}</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-4 text-center">
          <p className="text-xs text-muted-foreground">
            {query.trim() ? t('datasets.no_analyses_match') : t('datasets.no_analyses')}
          </p>
        </div>
      ) : (
        <div className="py-1" ref={listRef}>
          {visible.map((analysis) => {
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
                      data-analysis-id={analysis.id}
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
    </div>
  )
}

/**
 * The search field, self-focusing on open.
 *
 * A separate component so the focus-on-mount lives in ITS mount rather than in a
 * conditional effect of the list — the field only exists while search is open,
 * so mounting is exactly the moment to focus.
 */
function SearchField({
  value,
  onChange,
  onClose,
  onStep,
}: {
  value: string
  onChange: (v: string) => void
  onClose: () => void
  onStep: (delta: number) => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => { ref.current?.focus() }, [])
  return (
    <Input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={t('datasets.search_analyses')}
      className="h-6 text-xs"
      onKeyDown={(e) => {
        // Arrows walk the results without leaving the field, so you can type
        // then pick without reaching for the mouse.
        if (e.key === 'ArrowDown') { e.preventDefault(); onStep(1) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); onStep(-1) }
        else if (e.key === 'Escape') { e.preventDefault(); onClose() }
      }}
    />
  )
}
