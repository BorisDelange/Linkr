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
import { itemId, type PullDecision, type PullPlan } from '@/lib/pull-plan'
import { PullPanel } from './PullPanel'

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
 * No diff viewer: a project row is a folder of entities taken or left, and the
 * items under it already name each one. There is no merge projection to read.
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

  const decide = (ids: string[], decision: PullDecision) => {
    setDecisions((prev) => {
      const next = new Map(prev)
      for (const id of ids) next.set(id, decision)
      return next
    })
  }

  const handleFinalize = async (complete: boolean) => {
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
    void complete
  }

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
        onFinalize={handleFinalize}
        applying={applying}
      />
    </>
  )
}
