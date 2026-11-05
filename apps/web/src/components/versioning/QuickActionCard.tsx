import { GitPullRequest, Loader2, UploadCloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import type { QuickAction } from '@/lib/git-quick-actions'
import { cn } from '@/lib/utils'
import { SYNC_ALL_ACCENT } from '@/lib/versioning-accent'
import type { DataPushAction } from './ConfirmDataVersioningDialog'
import { changeTypeMeta } from './git-change-meta'

/**
 * A grid "widget" for one quick action: a colored header (the shared accent
 * for the primary "Sync all", so it reads the same on every versioning page), the
 * exact files it will commit — each with an A/M/D change badge so a deletion is
 * unmistakable — and its buttons: Propose (a merge request) and Sync (commit +
 * push), the same pair and colours as the Details tab; Propose alone, as the
 * primary, where the workspace takes changes by review only. Disabled when
 * there's nothing to push or a pull is required.
 */
export function QuickActionCard({
  action, canPush, canPropose, running, disabled, onRun, onOpenDiff, onViewMappings, t,
}: {
  action: QuickAction
  /** False in review mode: the card can only propose. */
  canPush: boolean
  /** Whether proposing exists at all (lib/git-proposals.ts). */
  canPropose: boolean
  /** THIS action is mid-run, and how → that button shows its spinner. */
  running: DataPushAction | null
  /** Disabled (another action is running, or a pull is required) — no spinner. */
  disabled: boolean
  onRun: (action: DataPushAction) => void
  /** Open the full-size diff viewer on a file — same as clicking a row in Details. */
  onOpenDiff: (path: string) => void
  /** Open the mappings review table. Absent for scopes without a mappings.json. */
  onViewMappings?: () => void
  t: (k: string, params?: Record<string, string>) => string
}) {
  const nothing = action.files.length === 0
  const accent = action.isSyncAll
  return (
    <div className={cn('flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm', accent && SYNC_ALL_ACCENT.border)}>
      <div className={cn('flex shrink-0 items-center gap-2 px-3 py-2', accent ? SYNC_ALL_ACCENT.headerBg : 'bg-muted/40')}>
        <UploadCloud size={14} className={cn('shrink-0', accent ? SYNC_ALL_ACCENT.icon : 'text-muted-foreground')} />
        <span className={cn('text-xs font-semibold', accent && SYNC_ALL_ACCENT.icon)}>{t(action.labelKey, { subject: action.subjectKey ? t(action.subjectKey) : '' })}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <p className="shrink-0 text-[11px] leading-relaxed text-muted-foreground">{t(action.descriptionKey)}</p>
        <div className="flex min-h-0 flex-1 flex-col">
          {nothing ? (
            <p className="text-[11px] italic text-muted-foreground/70">{t('versioning.quick_nothing')}</p>
          ) : (
            <>
              <SectionLabel as="p" className="tracking-wide text-muted-foreground/70">{t('versioning.quick_will_push')}</SectionLabel>
              {/* Long change lists scroll inside the card, which the grid
                  gives a fixed height. */}
              <ul className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
                {action.files.map((f) => {
                  const meta = changeTypeMeta(f.changeType)
                  return (
                    <li key={f.path} className="flex items-center gap-1.5 text-[11px]">
                      <span
                        className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-[9px] font-bold', meta.badgeClass)}
                        title={t(meta.labelKey)}
                      >
                        {meta.letter}
                      </span>
                      {/* Click opens the same full-size diff viewer as a Details row. */}
                      <button
                        type="button"
                        onClick={() => onOpenDiff(f.path)}
                        className="block min-w-0 flex-1 truncate text-left font-mono text-muted-foreground hover:text-foreground hover:underline"
                        title={f.path}
                      >
                        {f.path}
                      </button>
                      {/* A text diff of ~1500 generated JSON objects hides the one
                          thing being asked here — which mappings move. Mirrors the
                          pull side's Choose button. */}
                      {onViewMappings && f.path === 'mappings.json' && (
                        <button
                          type="button"
                          onClick={onViewMappings}
                          className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                        >
                          {t('versioning.push_view_mappings')}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
        <div className="mt-1 flex shrink-0 gap-2">
          {canPropose && <Button
            size="sm"
            variant={canPush ? 'outline' : 'default'}
            className="h-8 flex-1 gap-1.5 text-xs"
            onClick={() => onRun('propose')}
            disabled={running != null || disabled || nothing}
            title={t('versioning.propose_hint')}
          >
            {running === 'propose' ? <Loader2 size={13} className="animate-spin" /> : <GitPullRequest size={13} />}
            {t('versioning.quick_run_propose')}
          </Button>}
          {canPush && (
            <Button
              size="sm"
              className="h-8 flex-1 gap-1.5 text-xs"
              onClick={() => onRun('push')}
              disabled={running != null || disabled || nothing}
              title={t('versioning.quick_run_push_hint')}
            >
              {running === 'push' ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />}
              {t('versioning.quick_run_push')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
