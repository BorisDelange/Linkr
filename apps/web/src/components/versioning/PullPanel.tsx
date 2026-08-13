import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDownToLine, Check, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { SYNC_ALL_ACCENT } from '@/lib/versioning-accent'
import { groupGitFiles } from '@/lib/git-file-meta'
import { cardsForScope, cardMatches, type PullCardDef } from '@/lib/pull-quick-actions'
import {
  conflictCount,
  isCompletePull,
  isFullyReviewed,
  itemId,
  planIsEmpty,
  wholeFileId,
  type PullDecision,
  type PullFile,
  type PullPlan,
} from '@/lib/pull-plan'
import { PullFileRow } from './PullFileRow'

interface PullPanelProps {
  plan: PullPlan
  decisions: Map<string, PullDecision>
  onDecide: (ids: string[], decision: PullDecision) => void
  /** Quick actions vs Details — driven by the parent's tab so both stay in step. */
  mode: 'quick' | 'details'
  /** Open the merge projection for a file. Omitted by scopes whose rows ARE whole
   *  files (ETL): there the row's label already says everything a viewer would. */
  onOpenDiff?: (path: string) => void
  /** Open a file's per-item picker. Omitted where no file carries sub-items. */
  onOpenTable?: (file: PullFile) => void
  /** Apply the decisions. `complete` tells the caller which cursor may advance. */
  onFinalize: (complete: boolean) => void | Promise<void>
  applying: boolean
}

/**
 * The incoming half of the versioning panel: what the remote has that we don't.
 *
 * Replaces the push file list in place rather than opening a modal, so the user
 * meets one interface with two directions instead of two unrelated ones. Quick
 * actions groups the same files into cards; Details lists them raw. Both read the
 * same plan, so they cannot disagree.
 *
 * Finalizing is gated on every item having a verdict — accepting and declining are
 * both decisions, an untouched row is not. That distinction is what lets a partial
 * pull unblock the push without burying what the user declined (they keep their
 * version, and it reappears as a local change to push).
 */
export function PullPanel({
  plan, decisions, onDecide, mode, onOpenDiff, onOpenTable, onFinalize, applying,
}: PullPanelProps) {
  const { t } = useTranslation()

  const empty = planIsEmpty(plan)
  const reviewed = isFullyReviewed(plan, decisions)
  const complete = isCompletePull(plan, decisions)

  const pendingTotal = useMemo(() => {
    let n = 0
    for (const file of plan.files) {
      if (file.wholeFile) { if (!decisions.has(wholeFileId(file))) n++ ; continue }
      for (const item of file.items) if (!decisions.has(itemId(file, item))) n++
    }
    return n
  }, [plan, decisions])

  /** Every decision id a file covers (a whole-file row is a single id). */
  const idsOf = (file: PullFile): string[] =>
    file.wholeFile ? [wholeFileId(file)] : file.items.map((i) => itemId(file, i))

  const decideFile = (file: PullFile, decision: PullDecision) => onDecide(idsOf(file), decision)

  if (empty) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
        {t('versioning.pull_nothing')}
      </div>
    )
  }

  const footer = (
    <div className="flex shrink-0 items-center justify-end gap-3 border-t pt-3">
      {pendingTotal > 0 ? (
        <span className="mr-auto text-[11px] text-amber-700 dark:text-amber-400">
          {t('versioning.pull_pending_decisions', { count: pendingTotal })}
        </span>
      ) : (
        <span className="mr-auto text-[11px] text-muted-foreground">
          {complete ? t('versioning.pull_all_accepted') : t('versioning.pull_partial_summary')}
        </span>
      )}
      <Button
        size="sm"
        onClick={() => onFinalize(complete)}
        disabled={!reviewed || applying}
        className="gap-1.5"
      >
        {applying ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}
        {t('versioning.pull_finalize')}
      </Button>
    </div>
  )

  if (mode === 'quick') {
    const cards = cardsForScope(plan.scope)
      .map((card) => ({ card, files: plan.files.filter((f) => cardMatches(card, f.path)) }))
      // Empty cards are HIDDEN in pull (unlike push, where a greyed card usefully
      // says "nothing to send"): a pull is an event to process, and three empty
      // cards around one active one drown the signal.
      .filter(({ files }) => files.length > 0)

    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {cards.map(({ card, files }) => (
              <PullCard
                key={card.id}
                card={card}
                files={files}
                decisions={decisions}
                onDecide={(decision) => onDecide(files.flatMap(idsOf), decision)}
                onOpenTable={onOpenTable}
                onOpenDiff={onOpenDiff}
              />
            ))}
          </div>
        </div>
        {footer}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-xs font-medium">{t('versioning.pull_incoming')}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onDecide(plan.files.flatMap(idsOf), 'accept')}
              disabled={plan.files.some((f) => conflictCount(f) > 0)}
              className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Check size={10} />
              {t('versioning.pull_accept_all')}
            </button>
            <button
              type="button"
              onClick={() => onDecide(plan.files.flatMap(idsOf), 'decline')}
              className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <X size={10} />
              {t('versioning.pull_decline_all')}
            </button>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <TooltipProvider delayDuration={200}>
            {groupGitFiles(plan.scope, plan.files, (f) => f.path).map((group) => (
              <div key={group.category}>
                <div className="sticky top-0 z-10 bg-muted/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                  {t(`versioning.file_cat_${group.category}`)}
                </div>
                <ul className="divide-y">
                  {group.files.map((file) => (
                    <PullFileRow
                      key={file.path}
                      scope={plan.scope}
                      file={file}
                      decisions={decisions}
                      onDecideAll={decideFile}
                      onDecideItem={(id, decision) => onDecide([id], decision)}
                      onOpenDiff={onOpenDiff}
                      onOpenTable={onOpenTable}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </TooltipProvider>
        </ScrollArea>
      </div>
      {footer}
    </div>
  )
}

/** One quick-action card: what it brings in, and one gesture to take or refuse it. */
function PullCard({
  card, files, decisions, onDecide, onOpenTable, onOpenDiff,
}: {
  card: PullCardDef
  files: PullFile[]
  decisions: Map<string, PullDecision>
  onDecide: (decision: PullDecision) => void
  onOpenTable?: (file: PullFile) => void
  onOpenDiff?: (path: string) => void
}) {
  const { t } = useTranslation()
  const accent = !!card.isAll
  const items = files.flatMap((f) => f.items)
  const conflicts = files.reduce((n, f) => n + conflictCount(f), 0)
  const counts = {
    add: items.filter((i) => i.state === 'add').length,
    update: items.filter((i) => i.state === 'update').length,
    delete: items.filter((i) => i.state === 'delete').length,
  }
  // A file we could not break into items (an unkeyable source CSV) is offered
  // whole — the card must say so rather than show a count it doesn't have.
  const wholeFiles = files.filter((f) => f.wholeFile)

  const ids = files.flatMap((f) => (f.wholeFile ? [wholeFileId(f)] : f.items.map((i) => itemId(f, i))))
  const verdicts = ids.map((id) => decisions.get(id))
  const allAccepted = verdicts.length > 0 && verdicts.every((v) => v === 'accept')
  const allDeclined = verdicts.length > 0 && verdicts.every((v) => v === 'decline')

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm', accent && SYNC_ALL_ACCENT.border)}>
      <div className={cn('flex items-center gap-2 px-3 py-2', accent ? SYNC_ALL_ACCENT.headerBg : 'bg-muted/40')}>
        <ArrowDownToLine size={14} className={cn('shrink-0', accent ? SYNC_ALL_ACCENT.icon : 'text-muted-foreground')} />
        <span className={cn('text-xs font-semibold', accent && SYNC_ALL_ACCENT.icon)}>
          {t(`versioning.pull_card_${card.id}`)}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {counts.add > 0 && <Tag cls="emerald" label={t('versioning.pull_count_add', { count: counts.add })} />}
          {counts.update > 0 && <Tag cls="sky" label={t('versioning.pull_count_update', { count: counts.update })} />}
          {counts.delete > 0 && <Tag cls="rose" label={t('versioning.pull_count_delete', { count: counts.delete })} />}
          {conflicts > 0 && <Tag cls="amber" label={t('versioning.pull_count_conflict', { count: conflicts })} />}
          {wholeFiles.length > 0 && (
            <span className="text-muted-foreground">{t('versioning.pull_whole_file')}</span>
          )}
        </div>

        <ul className="min-h-0 flex-1 space-y-0.5">
          {files.map((f) => (
            <li key={f.path} className="flex items-center gap-1.5 text-[11px]">
              {/* Only render a button where there is a viewer to open: a scope
                  without one would otherwise show a clickable path that does
                  nothing at all. */}
              {onOpenDiff ? (
                <button
                  type="button"
                  onClick={() => onOpenDiff(f.path)}
                  className="block min-w-0 flex-1 truncate text-left font-mono text-muted-foreground hover:text-foreground hover:underline"
                  title={f.path}
                >
                  {f.path}
                </button>
              ) : (
                <span className="block min-w-0 flex-1 truncate text-left font-mono text-muted-foreground" title={f.path}>
                  {f.path}
                </span>
              )}
              {onOpenTable && f.pickable && f.items.length > 0 && (
                <button
                  type="button"
                  onClick={() => onOpenTable(f)}
                  className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {t('versioning.pull_choose')}
                </button>
              )}
            </li>
          ))}
        </ul>

        {conflicts > 0 && (
          <p className="flex items-start gap-1 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400">
            <AlertTriangle size={11} className="mt-px shrink-0" />
            {/* Where the card has no picker to open (metadata fields), say where
                the choice CAN be made — otherwise the card refuses to accept and
                offers nothing to click. */}
            {files.some((f) => f.pickable)
              ? t('versioning.pull_conflicts_need_choice')
              : t('versioning.pull_conflicts_in_details')}
          </p>
        )}

        <div className="mt-1 flex gap-1.5">
          <Button
            size="sm"
            variant={accent && !allAccepted ? 'default' : 'outline'}
            // Green once taken: the button reads as a decision already made rather
            // than an action still to run, matching the accepted rows below it.
            className={cn(
              'h-7 flex-1 gap-1 px-2 text-[11px]',
              allAccepted &&
                'border-emerald-500 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-400',
            )}
            onClick={() => onDecide('accept')}
            // Bulk-accepting a conflict would silently pick a side in the one case
            // where the user's explicit choice is required.
            disabled={conflicts > 0}
          >
            <Check size={12} />
            {allAccepted ? t('versioning.pull_accepted') : t('versioning.pull_take')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={cn('h-7 gap-1 px-2 text-[11px]', allDeclined && 'bg-muted')}
            onClick={() => onDecide('decline')}
            title={t('versioning.pull_keep_mine_hint')}
          >
            <X size={12} />
            {t('versioning.pull_keep_mine')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Tag({ cls, label }: { cls: 'emerald' | 'sky' | 'rose' | 'amber'; label: string }) {
  const map = {
    emerald: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    sky: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    rose: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  }
  return <span className={cn('rounded px-1.5 py-0.5 font-semibold', map[cls])}>{label}</span>
}
