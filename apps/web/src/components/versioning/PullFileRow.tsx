import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Info, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { gitFileMeta } from '@/lib/git-file-meta'
import { changeTypeMeta } from './git-change-meta'
import {
  conflictCount,
  pendingCount,
  pullChangeType,
  wholeFileId,
  type PullDecision,
  type PullFile,
} from '@/lib/pull-plan'
import type { GitScope } from '@/lib/api/git'

interface PullFileRowProps {
  scope: GitScope
  file: PullFile
  decisions: Map<string, PullDecision>
  /** Accept or decline every item in this file (whole-file rows: the row itself). */
  onDecideAll: (file: PullFile, decision: PullDecision) => void
  /** Accept or decline one item — used by the expanded sub-rows. */
  onDecideItem: (id: string, decision: PullDecision) => void
  /** Open the diff viewer on this file. */
  onOpenDiff: (path: string) => void
  /** Open the per-item table (mappings) — absent when the file has no picker. */
  onOpenTable?: (file: PullFile) => void
}

/**
 * One incoming file in the Details pull list — the mirror of `GitFileRow`.
 *
 * Three states rather than a checkbox's two: a file is undecided, accepted, or
 * declined. Declining is a *decision* (the user keeps their version, which then
 * shows up as a local change to push); leaving it untouched is not, and blocks
 * finalizing. A checkbox cannot express that difference, so the row carries an
 * explicit accept/decline pair instead.
 *
 * A file holding conflicts never resolves in bulk: the row shows an amber count
 * and routes to the table, since an implicit choice is exactly wrong there.
 */
export function PullFileRow({ scope, file, decisions, onDecideAll, onDecideItem, onOpenDiff, onOpenTable }: PullFileRowProps) {
  const { t } = useTranslation()
  const descriptionKey = gitFileMeta(scope, file.path).descriptionKey
  const description = descriptionKey ? t(descriptionKey) : null
  const conflicts = conflictCount(file)
  const pending = file.wholeFile
    ? (decisions.has(wholeFileId(file)) ? 0 : 1)
    : pendingCount(file, decisions)
  const total = file.wholeFile ? 1 : file.items.length
  const decided = total - pending
  const badge = changeTypeMeta(pullChangeType(file))

  // A file is "accepted"/"declined" as a whole only when every item agrees;
  // a mixed file stays neutral so the row never overstates the user's intent.
  const verdicts = file.wholeFile
    ? [decisions.get(wholeFileId(file))]
    : file.items.map((i) => decisions.get(`${file.path} ${i.key}`))
  const allAccepted = verdicts.length > 0 && verdicts.every((v) => v === 'accept')
  const allDeclined = verdicts.length > 0 && verdicts.every((v) => v === 'decline')

  // Items are listed under the row when there is no picker to send them to, so a
  // conflict is always resolvable somewhere: in the table for mappings, here for
  // metadata fields. Without this, a conflicted project.json was a dead end —
  // bulk-accept refused, and nothing else to click.
  const showItems = !file.wholeFile && !file.pickable && file.items.length > 0

  return (
    <li className={cn(allAccepted && 'bg-emerald-500/5', allDeclined && 'bg-muted/40')}>
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50">
      <button
        type="button"
        onClick={() => onOpenDiff(file.path)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
      >
        <span
          className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[9px] font-bold', badge.badgeClass)}
          title={t(badge.labelKey)}
        >
          {badge.letter}
        </span>
        <span className={cn('truncate font-mono', allDeclined && 'text-muted-foreground line-through')}>
          {file.path}
        </span>
      </button>

      {/* Item counts — what is actually coming in through this file. */}
      {!file.wholeFile && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {t('versioning.pull_items_decided', { decided, total })}
        </span>
      )}

      {conflicts > 0 && (
        // Clickable only where a picker exists to route to; elsewhere the count
        // still has to be visible, since it is why bulk-accept is refused.
        file.pickable && onOpenTable ? (
          <button
            type="button"
            onClick={() => onOpenTable(file)}
            className="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-500/25 dark:text-amber-400"
            title={t('versioning.pull_conflicts_need_choice')}
          >
            <AlertTriangle size={10} />
            {t('versioning.pull_count_conflict', { count: conflicts })}
          </button>
        ) : (
          <span
            className="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400"
            title={t('versioning.pull_conflicts_need_choice')}
          >
            <AlertTriangle size={10} />
            {t('versioning.pull_count_conflict', { count: conflicts })}
          </span>
        )
      )}

      {/* No item-count threshold: a source CSV's "items" are change-type counters,
          so even a single one ("5 removed") is exactly what the user needs to open
          — which five? A one-row mappings file is self-explanatory, but that is the
          picker's own concern, not a reason to hide the way in. */}
      {onOpenTable && file.pickable && file.items.length > 0 && (
        <button
          type="button"
          onClick={() => onOpenTable(file)}
          className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        >
          {t('versioning.pull_choose')}
        </button>
      )}

      {/* Accept / decline for the whole file. Bulk-accept is refused while
          conflicts remain — they need an individual choice, made either in the
          picker (mappings) or on the expanded items below (metadata fields).
          Declining everything is always valid: it keeps the local version. */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onDecideAll(file, 'accept')}
          disabled={conflicts > 0}
          title={conflicts > 0 ? t('versioning.pull_conflicts_need_choice') : t('versioning.pull_accept_all')}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded border',
            allAccepted ? 'border-emerald-500 bg-emerald-500/15 text-emerald-600' : 'text-muted-foreground hover:text-foreground',
            conflicts > 0 && 'cursor-not-allowed opacity-40',
          )}
        >
          <Check size={12} />
        </button>
        <button
          type="button"
          onClick={() => onDecideAll(file, 'decline')}
          title={t('versioning.pull_decline_all')}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded border',
            allDeclined ? 'border-muted-foreground bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <X size={12} />
        </button>
      </div>

      {description && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 cursor-help text-muted-foreground/60 hover:text-muted-foreground" aria-label={description}>
              <Info size={12} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-xs text-xs">
            {description}
          </TooltipContent>
        </Tooltip>
      )}
    </div>

    {showItems && (
      <ul className="border-t bg-muted/20">
        {file.items.map((item) => {
          const id = `${file.path} ${item.key}`
          const verdict = decisions.get(id)
          return (
            <li key={item.key} className="flex items-center gap-2 py-1 pl-9 pr-3 text-xs">
              <span className={cn('truncate font-medium', verdict === 'decline' && 'text-muted-foreground line-through')}>
                {item.label}
              </span>
              {item.state === 'conflict' && (
                <span className="shrink-0 rounded bg-amber-500/15 px-1 py-px text-[9px] font-semibold uppercase text-amber-700 dark:text-amber-400">
                  {t('versioning.pull_change_conflict')}
                </span>
              )}
              {item.detail && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.detail}>
                  {item.detail}
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onDecideItem(id, 'accept')}
                  title={t('versioning.pull_take_theirs')}
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded border',
                    verdict === 'accept' ? 'border-emerald-500 bg-emerald-500/15 text-emerald-600' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Check size={10} />
                </button>
                <button
                  type="button"
                  onClick={() => onDecideItem(id, 'decline')}
                  title={t('versioning.pull_keep_mine')}
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded border',
                    verdict === 'decline' ? 'border-muted-foreground bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <X size={10} />
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    )}
    </li>
  )
}
