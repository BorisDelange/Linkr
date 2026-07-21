import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDownToLine, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  prepareProjectPull,
  applyProjectPull,
  type PreparedProjectPull,
  type ProjectPullSelection,
  type PullItem,
} from '@/lib/project-pull'

interface ProjectPullDialogProps {
  projectUid: string
  branch: string
  onClose: () => void
  /** Called after a successful apply so the panel refreshes status + sync anchor. */
  onPulled: () => void | Promise<void>
}

type GroupKey = 'dashboards' | 'scripts' | 'cohorts' | 'datasets' | 'pipeline'

const GROUP_ORDER: { key: GroupKey; labelKey: string }[] = [
  { key: 'dashboards', labelKey: 'versioning.pull_group_dashboards' },
  { key: 'scripts', labelKey: 'versioning.pull_group_scripts' },
  { key: 'cohorts', labelKey: 'versioning.pull_group_cohorts' },
  { key: 'datasets', labelKey: 'versioning.pull_group_datasets' },
  { key: 'pipeline', labelKey: 'versioning.pull_group_pipeline' },
]

/**
 * Additive-overlay pull for a project. Clones the remote, then lets the user pick,
 * per group, which remote entities to bring in — new items default to checked,
 * existing items (would overwrite) default to unchecked so nothing is replaced
 * without an explicit tick. README/todos/notes is a single block toggle.
 */
export function ProjectPullDialog({ projectUid, branch, onClose, onPulled }: ProjectPullDialogProps) {
  const { t } = useTranslation()
  const [prepared, setPrepared] = useState<PreparedProjectPull | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  const [sel, setSel] = useState<Record<GroupKey, Set<string>>>({
    dashboards: new Set(), scripts: new Set(), cohorts: new Set(), datasets: new Set(), pipeline: new Set(),
  })
  const [takeReadme, setTakeReadme] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    prepareProjectPull(projectUid, branch)
      .then((p) => {
        if (cancelled) return
        setPrepared(p)
        // New items are checked by default; existing (overwrite) items are not.
        const seed = (items: PullItem[]) => new Set(items.filter((i) => !i.exists).map((i) => i.key))
        setSel({
          dashboards: seed(p.plan.dashboards),
          scripts: seed(p.plan.scripts),
          cohorts: seed(p.plan.cohorts),
          datasets: seed(p.plan.datasets),
          pipeline: seed(p.plan.pipeline),
        })
        setTakeReadme(false)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [projectUid, branch])

  const plan = prepared?.plan
  const groupItems = (key: GroupKey): PullItem[] => (plan ? plan[key] : [])

  const nothingToPull = useMemo(
    () =>
      plan != null &&
      GROUP_ORDER.every((g) => plan[g.key].length === 0) &&
      !plan.readmeChanged,
    [plan],
  )

  const selectedTotal = useMemo(
    () => GROUP_ORDER.reduce((n, g) => n + sel[g.key].size, 0) + (takeReadme ? 1 : 0),
    [sel, takeReadme],
  )

  const toggle = (group: GroupKey, key: string) => {
    setSel((s) => {
      const next = new Set(s[group])
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { ...s, [group]: next }
    })
  }

  const toggleGroupAll = (group: GroupKey) => {
    const items = groupItems(group)
    setSel((s) => {
      const allSelected = items.length > 0 && items.every((i) => s[group].has(i.key))
      return { ...s, [group]: allSelected ? new Set() : new Set(items.map((i) => i.key)) }
    })
  }

  const handleApply = async () => {
    if (!prepared || applying || selectedTotal === 0) return
    setApplying(true)
    try {
      const selection: ProjectPullSelection = {
        dashboards: sel.dashboards,
        scripts: sel.scripts,
        cohorts: sel.cohorts,
        datasets: sel.datasets,
        pipeline: sel.pipeline,
        readme: takeReadme,
      }
      await applyProjectPull(projectUid, prepared, selection)
      await onPulled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80vh] w-[92vw] max-w-[640px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ArrowDownToLine size={16} />
            {t('versioning.pull_project_title')}
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
          <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
            {t('versioning.pull_nothing')}
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 p-4">
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t('versioning.pull_project_intro')}</p>

              {GROUP_ORDER.map((g) => {
                const items = groupItems(g.key)
                if (items.length === 0) return null
                const allSelected = items.every((i) => sel[g.key].has(i.key))
                return (
                  <Section
                    key={g.key}
                    title={t(g.labelKey)}
                    action={
                      <button
                        type="button"
                        onClick={() => toggleGroupAll(g.key)}
                        className="text-[11px] font-medium text-primary hover:underline"
                      >
                        {t('versioning.pull_group_select_all')}
                        {allSelected ? ' ✓' : ''}
                      </button>
                    }
                  >
                    <ul className="divide-y">
                      {items.map((it) => (
                        <li key={it.key} className="flex items-center gap-2 py-1.5 text-xs">
                          <Checkbox checked={sel[g.key].has(it.key)} onCheckedChange={() => toggle(g.key, it.key)} />
                          <span className="min-w-0 flex-1 truncate font-mono" title={it.label}>{it.label}</span>
                          <Badge overwrite={it.exists} t={t} />
                        </li>
                      ))}
                    </ul>
                  </Section>
                )
              })}

              {plan?.readmeChanged && (
                <Section title={t('versioning.pull_group_readme')}>
                  <label className="flex items-center gap-2 py-1 text-xs">
                    <Checkbox checked={takeReadme} onCheckedChange={(v) => setTakeReadme(!!v)} />
                    <span>{t('versioning.pull_readme_replace')}</span>
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
            onClick={handleApply}
            disabled={loading || !!error || nothingToPull || applying || selectedTotal === 0}
            className="gap-1.5"
          >
            {applying ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}
            {t('versioning.pull_apply')}
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

function Badge({ overwrite, t }: { overwrite: boolean; t: (k: string) => string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
        overwrite
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
          : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
      )}
    >
      {overwrite ? t('versioning.pull_badge_overwrite') : t('versioning.pull_badge_new')}
    </span>
  )
}
