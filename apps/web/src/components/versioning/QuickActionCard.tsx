import { Loader2, UploadCloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import type { QuickAction } from '@/lib/git-quick-actions'
import { cn } from '@/lib/utils'
import { SYNC_ALL_ACCENT } from '@/lib/versioning-accent'
import { changeTypeMeta } from './git-change-meta'

/**
 * A grid "widget" for one quick action: a colored header (the shared accent
 * for the primary "Sync all", so it reads the same on every versioning page), the
 * exact files it will commit — each with an A/M/D change badge so a deletion is
 * unmistakable — and a commit+push button. Disabled when there's nothing to push
 * or a pull is required.
 */
export function QuickActionCard({
  action, primary, running, disabled, onRun, onOpenDiff, onViewMappings, t, runLabel,
}: {
  action: QuickAction
  /** In review mode the card proposes instead of pushing, and says so. */
  runLabel?: string
  primary: boolean
  /** THIS action is mid-commit → show its spinner. */
  running: boolean
  /** Disabled (another action is running, or a pull is required) — no spinner. */
  disabled: boolean
  onRun: () => void
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
      <div className={cn('flex items-center gap-2 px-3 py-2', accent ? SYNC_ALL_ACCENT.headerBg : 'bg-muted/40')}>
        <UploadCloud size={14} className={cn('shrink-0', accent ? SYNC_ALL_ACCENT.icon : 'text-muted-foreground')} />
        <span className={cn('text-xs font-semibold', accent && SYNC_ALL_ACCENT.icon)}>{t(action.labelKey, { subject: action.subjectKey ? t(action.subjectKey) : '' })}</span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t(action.descriptionKey)}</p>
        <div className="min-h-0 flex-1">
          {nothing ? (
            <p className="text-[11px] italic text-muted-foreground/70">{t('versioning.quick_nothing')}</p>
          ) : (
            <>
              <SectionLabel as="p" className="tracking-wide text-muted-foreground/70">{t('versioning.quick_will_push')}</SectionLabel>
              {/* Long change lists scroll inside the card so the widgets never
                  outgrow the dialog. */}
              <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
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
        <Button
          size="sm"
          variant={primary ? 'default' : 'outline'}
          className="mt-1 h-8 w-full gap-1.5 text-xs"
          onClick={onRun}
          disabled={running || disabled || nothing}
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />}
          {runLabel ?? t(action.labelKey, { subject: action.subjectKey ? t(action.subjectKey) : '' })}
        </Button>
      </div>
    </div>
  )
}
