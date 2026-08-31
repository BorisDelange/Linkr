import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { applyProjectPull, prepareProjectPull, type PreparedProjectPull } from '@/lib/project-pull'
import {
  buildProjectPullPlan,
  projectGroupForPath,
  PROJECT_DOCS_FILE,
  PROJECT_DOCS_KEY,
  type ProjectPullGroupKey,
} from '@/lib/project-pull-plan-builder'
import { itemId, planIsEmpty, type PullDecision, type PullPlan } from '@/lib/pull-plan'
import {
  buildProjectDiffPlan,
  buildProjectPullDiff,
  entityDiffPath,
  isDiffableGroupPath,
} from '@/lib/project-pull-diff'
import { PullPanel } from './PullPanel'
import { PullDiffDialog } from './PullDiffDialog'

interface ProjectPullProps {
  projectUid: string
  branch: string
  /** The remote head the panel knows about — a plan prepared against a different
   *  one is stale (the remote advanced) and must be recomputed. */
  remoteHead: string | null
  mode: 'quick' | 'details'
  /** Called once the pull is applied so the panel refreshes status + cursors. */
  onPulled: () => void | Promise<void>
}

/** Draft decisions survive closing the tab, so a half-made review isn't lost.
 *  Keyed by project+branch and dropped when the remote head moves. */
interface PullDraft {
  prepared: PreparedProjectPull
  decisions: Map<string, PullDecision>
}
const _draftCache = new Map<string, PullDraft>()
const draftKey = (projectUid: string, branch: string) => `${projectUid}|${branch}`

/**
 * The project pull, rendered inline where the push list normally sits — the same
 * shell as the mapping-project and ETL pulls, over a different plan builder.
 *
 * Scripts open a diff: they are text, and "which lines changed" is what decides
 * whether to take one. The other groups are structured entities whose export is a
 * rewritten JSON document, so a diff would show regenerated ids rather than the
 * change itself — their rows stay unclickable (see lib/project-pull-diff).
 */
export function ProjectPull({ projectUid, branch, remoteHead, mode, onPulled }: ProjectPullProps) {
  const { t } = useTranslation()
  const key = draftKey(projectUid, branch)

  const cached = _draftCache.get(key)
  if (cached && cached.prepared.clonedOid !== remoteHead) _draftCache.delete(key)

  const [prepared, setPrepared] = useState<PreparedProjectPull | null>(() => _draftCache.get(key)?.prepared ?? null)
  const [decisions, setDecisions] = useState<Map<string, PullDecision>>(
    () => new Map(_draftCache.get(key)?.decisions ?? []),
  )
  const [loading, setLoading] = useState(!_draftCache.has(key))
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [diffPath, setDiffPath] = useState<string | null>(null)

  useEffect(() => {
    if (_draftCache.has(key)) return
    let cancelled = false
    setLoading(true)
    setError(null)
    prepareProjectPull(projectUid, branch)
      .then((p) => {
        if (cancelled) return
        setPrepared(p)
        setDecisions(new Map())
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [projectUid, branch, key, remoteHead])

  useEffect(() => {
    if (prepared) _draftCache.set(key, { prepared, decisions })
  }, [key, prepared, decisions])

  const plan: PullPlan | null = useMemo(
    () => (prepared ? buildProjectPullPlan(prepared, branch) : null),
    [prepared, branch],
  )

  // The dialog's own plan: one row per script, rather than the group row the
  // panel ticks. Only scripts are diffable, so it is empty for every other group.
  const diffPlan: PullPlan | null = useMemo(
    () => (prepared ? buildProjectDiffPlan(prepared, branch) : null),
    [prepared, branch],
  )

  // The panel hands back the GROUP path (`cohorts/`); the viewer opens on one
  // entity, so land on that group's first item and let the sidebar do the rest.
  const openDiff = (path: string) => {
    const group = projectGroupForPath(path)
    if (!group || !isDiffableGroupPath(path)) return
    const first = prepared?.plan[group][0]
    if (first) setDiffPath(entityDiffPath(group as 'scripts' | 'cohorts' | 'pipeline', first.key))
  }

  const decide = (ids: string[], decision: PullDecision) => {
    setDecisions((prev) => {
      const next = new Map(prev)
      for (const id of ids) next.set(id, decision)
      return next
    })
  }

  // The panel's `complete` is deliberately ignored: which cursor may advance is
  // derived inside applyProjectPull from the same selection, so taking it from
  // here too would be a second, independently-computed answer to one question —
  // which is how the anchor once moved on a pull that took nothing.
  const handleFinalize = async () => {
    if (!prepared || !plan || applying) return
    setApplying(true)
    setError(null)
    try {
      const groups: Record<ProjectPullGroupKey, Set<string>> = {
        dashboards: new Set(), scripts: new Set(), cohorts: new Set(),
        datasets: new Set(), pipeline: new Set(),
      }
      let readme = false
      for (const file of plan.files) {
        const group = projectGroupForPath(file.path)
        for (const item of file.items) {
          if (decisions.get(itemId(file, item)) !== 'accept') continue
          if (group) groups[group].add(item.key)
          else if (file.path === PROJECT_DOCS_FILE && item.key === PROJECT_DOCS_KEY) readme = true
        }
      }
      const nothingTaken = !readme && Object.values(groups).every((s) => s.size === 0)
      await applyProjectPull(projectUid, prepared, {
        ...groups,
        readme,
        // Taking nothing IS the resolution "keep mine" — but only when it was
        // decided, never when the user simply hasn't ticked anything yet.
        keepLocal: nothingTaken,
        decided: true,
      })
      _draftCache.delete(key)
      await onPulled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // The plan described a commit we failed to apply; recompute rather than let
      // the user finalize again against a state that no longer matches the DB.
      _draftCache.delete(key)
    } finally {
      setApplying(false)
    }
  }

  // An empty plan still has to advance the cursors, or the entity stays "behind"
  // forever: the remote moved (sync_state compares oids), but nothing in that
  // commit differs from what we already hold, so PullPanel shows "nothing to
  // pull" and offers no button to press. Left alone the banner never clears —
  // and it gates the push, so the user cannot send their own work either.
  // Finalizing here is the honest record: every incoming item was decided (there
  // were none) and we hold the content, so both cursors may move.
  const emptyPlan = !!plan && planIsEmpty(plan)
  useEffect(() => {
    if (!emptyPlan || applying) return
    void handleFinalize()
    // handleFinalize is redefined each render, so it cannot be a dependency
    // without re-firing; `emptyPlan` plus the `applying` guard bound this to one
    // run per computed plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emptyPlan])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        {t('versioning.pull_computing')}
      </div>
    )
  }
  if (error && !plan) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center text-sm text-destructive">
        <AlertTriangle size={24} />
        {error}
      </div>
    )
  }
  if (!plan) return null

  return (
    <>
      {error && (
        <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <PullPanel
        plan={plan}
        decisions={decisions}
        onDecide={decide}
        mode={mode}
        // Withheld when nothing is diffable: a row that looks clickable and does
        // nothing reads as broken (the same rule PullFileRow applies).
        onOpenDiff={diffPlan?.files.length ? openDiff : undefined}
        canOpenDiff={(file) => isDiffableGroupPath(file.path)}
        onFinalize={handleFinalize}
        applying={applying}
      />

      {diffPath && prepared && diffPlan && (
        <PullDiffDialog
          plan={diffPlan}
          initialPath={diffPath}
          buildDiff={(file) => buildProjectPullDiff(file, prepared, prepared.localScriptContent)}
          onClose={() => setDiffPath(null)}
        />
      )}
    </>
  )
}
