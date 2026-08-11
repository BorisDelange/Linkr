import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDownToLine, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  applyEtlPull,
  prepareEtlPull,
  ETL_PULL_GROUPS,
  type EtlPullGroup,
  type EtlPullItem,
  type PreparedEtlPull,
} from '@/lib/etl-pull'

interface EtlPullDialogProps {
  pipelineId: string
  branch: string
  onClose: () => void
  /** Called after a successful apply so the panel refreshes status + sync anchor. */
  onPulled: () => void | Promise<void>
}

const GROUP_LABEL: Record<EtlPullGroup, string> = {
  docs: 'versioning.pull_group_docs',
  // Not `pull_group_scripts`, which reads "IDE scripts" — these are the pipeline's own.
  scripts: 'versioning.pull_group_etl_scripts',
  mappings: 'versioning.pull_group_mappings',
  other: 'versioning.pull_group_other',
}

/**
 * Additive-overlay pull for an ETL pipeline, group by group.
 *
 * Defaults follow the project dialog: new files checked, files that would
 * OVERWRITE local content unchecked, so nothing is replaced without an explicit
 * tick.
 *
 * Only actionable files are listed — `buildEtlPullPlan` drops the ones already
 * identical to the remote. A pipeline is dozens of scripts and a pull usually
 * touches one or two, so listing the rest buried the real changes.
 */
export function EtlPullDialog({ pipelineId, branch, onClose, onPulled }: EtlPullDialogProps) {
  const { t } = useTranslation()
  const [prepared, setPrepared] = useState<PreparedEtlPull | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [paths, setPaths] = useState<Set<string>>(new Set())
  const [takeSettings, setTakeSettings] = useState(false)
  const [anchoring, setAnchoring] = useState(false)
  // Ref, not the state: the effect must not re-run when the flag flips, and
  // reading state inside a guard it does not depend on is a lie to the linter.
  const anchoredRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    prepareEtlPull(pipelineId, branch)
      .then((p) => {
        if (cancelled) return
        setPrepared(p)
        // New files checked; an overwrite needs an explicit tick.
        const seed = new Set<string>()
        for (const group of ETL_PULL_GROUPS) {
          for (const item of p.plan.groups[group]) {
            if (!item.exists) seed.add(item.key)
          }
        }
        setPaths(seed)
        setTakeSettings(false)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [pipelineId, branch])



  const plan = prepared?.plan
  const items = (group: EtlPullGroup): EtlPullItem[] => plan?.groups[group] ?? []

  // The plan only ever contains actionable files, so an empty one IS "up to date".
  const nothingToPull = useMemo(
    () => plan != null
      && ETL_PULL_GROUPS.every((g) => plan.groups[g].length === 0)
      && !plan.settingsChanged,
    [plan],
  )

  const selectedTotal = paths.size + (takeSettings ? 1 : 0)

  /**
   * Nothing to pull, but the anchor is behind → record that we are in sync.
   *
   * The local content already matches the remote (that is WHY the plan is empty),
   * so the only thing missing is the baseline. Without this the dialog was a dead
   * end: "up to date" with Apply disabled, while the banner outside kept saying
   * the remote was ahead and the push stayed blocked on "pull first".
   */
  useEffect(() => {
    if (!prepared || !nothingToPull || anchoredRef.current) return
    anchoredRef.current = true
    let cancelled = false
    setAnchoring(true)
    applyEtlPull(pipelineId, prepared, { paths: new Set(), settings: false })
      .then(() => { if (!cancelled) void onPulled() })
      .catch(() => {
        // Leave the banner up rather than claim a sync we failed to record, and
        // allow another attempt.
        anchoredRef.current = false
      })
      .finally(() => { if (!cancelled) setAnchoring(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepared, nothingToPull])

  const toggle = (key: string) => {
    setPaths((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleGroupAll = (group: EtlPullGroup) => {
    const keys = items(group).map((i) => i.key)
    setPaths((s) => {
      const allSelected = keys.length > 0 && keys.every((k) => s.has(k))
      const next = new Set(s)
      for (const k of keys) {
        if (allSelected) next.delete(k)
        else next.add(k)
      }
      return next
    })
  }

  // Zero selection is a valid outcome: discard the remote changes, keep the local
  // content, and anchor so the behind banner clears and the push unblocks.
  const keepLocal = selectedTotal === 0

  const handleApply = async () => {
    if (!prepared || applying) return
    setApplying(true)
    try {
      await applyEtlPull(pipelineId, prepared, { paths, settings: takeSettings, keepLocal })
      await onPulled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* h-[80vh], not max-h: a flex child with `flex-1 min-h-0` can only shrink
          against a RESOLVED height, so with max-h alone the file list grew past
          the dialog and the footer scrolled off screen instead of the list
          scrolling inside it. */}
      <DialogContent className="flex h-[80vh] max-h-[80vh] w-[92vw] max-w-[640px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ArrowDownToLine size={16} />
            {t('versioning.pull_etl_title')}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {t('versioning.pull_computing')}
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center text-sm text-destructive">
            <AlertTriangle size={24} />
            {error}
          </div>
        ) : nothingToPull ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center text-sm text-muted-foreground">
            {anchoring && <Loader2 size={14} className="animate-spin" />}
            {t('versioning.pull_nothing')}
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 p-4">
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t('versioning.pull_etl_intro')}</p>

              {ETL_PULL_GROUPS.map((group) => {
                const list = items(group)
                if (list.length === 0) return null
                const allSelected = list.every((i) => paths.has(i.key))
                return (
                  <Section
                    key={group}
                    title={`${t(GROUP_LABEL[group])} (${list.length})`}
                    action={(
                      <button
                        type="button"
                        onClick={() => toggleGroupAll(group)}
                        className="text-[11px] font-medium text-primary hover:underline"
                      >
                        {t('versioning.pull_group_select_all')}
                        {allSelected ? ' ✓' : ''}
                      </button>
                    )}
                  >
                    <ul className="divide-y">
                      {list.map((item) => (
                        <li key={item.key} className="flex items-center gap-2 py-1.5 text-xs">
                          <Checkbox
                            checked={paths.has(item.key)}
                            onCheckedChange={() => toggle(item.key)}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono" title={item.key}>
                            {item.key}
                          </span>
                          <StateBadge item={item} />
                        </li>
                      ))}
                    </ul>
                  </Section>
                )
              })}

              {plan?.settingsChanged && (
                <Section title={t('versioning.pull_group_settings')}>
                  <label className="flex items-center gap-2 py-1 text-xs">
                    <Checkbox checked={takeSettings} onCheckedChange={(v) => setTakeSettings(!!v)} />
                    <span>{t('versioning.pull_etl_settings_replace')}</span>
                  </label>
                </Section>
              )}
            </div>
          </ScrollArea>
        )}

        <div className="flex shrink-0 items-center justify-end gap-3 border-t px-4 py-3">
          {!loading && !error && !nothingToPull && selectedTotal === 0 && (
            <span className="mr-auto text-[11px] text-muted-foreground">{t('versioning.pull_nothing_selected')}</span>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={applying}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            variant={keepLocal ? 'outline' : 'default'}
            onClick={handleApply}
            disabled={loading || !!error || nothingToPull || applying}
            className="gap-1.5"
          >
            {applying ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}
            {keepLocal ? t('versioning.pull_keep_local') : t('versioning.pull_apply')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
        {action}
      </div>
      <div className="rounded-md border px-3">{children}</div>
    </div>
  )
}

function StateBadge({ item }: { item: EtlPullItem }) {
  const { t } = useTranslation()
  const [labelKey, className] = item.exists
    ? ['versioning.pull_badge_overwrite', 'bg-amber-500/15 text-amber-700 dark:text-amber-400']
    : ['versioning.pull_badge_new', 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400']
  return (
    <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide', className)}>
      {t(labelKey)}
    </span>
  )
}
