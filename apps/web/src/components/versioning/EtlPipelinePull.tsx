import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { applyEtlPull, prepareEtlPull, type PreparedEtlPull } from '@/lib/etl-pull'
import { buildEtlPipelinePullPlan, ETL_SETTINGS_FILE } from '@/lib/etl-pull-plan-builder'
import { buildEtlPullDiff } from '@/lib/etl-pull-diff'
import { wholeFileId, type PullDecision, type PullPlan } from '@/lib/pull-plan'
import { PullPanel } from './PullPanel'
import { PullDiffDialog } from './PullDiffDialog'

interface EtlPipelinePullProps {
  pipelineId: string
  branch: string
  /** The remote head the panel knows about — a plan prepared against a different
   *  one is stale (the remote advanced) and must be recomputed. */
  remoteHead: string | null
  mode: 'quick' | 'details'
  /** Called once the pull is applied so the panel refreshes status + cursors. */
  onPulled: () => void | Promise<void>
}

/** Draft decisions survive closing the tab, so a half-made review isn't lost.
 *  Keyed by pipeline+branch and dropped when the remote head moves. */
interface PullDraft {
  prepared: PreparedEtlPull
  decisions: Map<string, PullDecision>
}
const _draftCache = new Map<string, PullDraft>()
const draftKey = (pipelineId: string, branch: string) => `${pipelineId}|${branch}`

/**
 * The ETL pipeline pull, rendered inline where the push list normally sits — the
 * same shell as the mapping-project pull, over a different plan builder.
 *
 * No diff viewer here: an ETL row is a whole file taken or left, so there is no
 * merge projection to read. Clicking a row does nothing extra rather than opening
 * a viewer that would only echo the row's own label.
 */
export function EtlPipelinePull({ pipelineId, branch, remoteHead, mode, onPulled }: EtlPipelinePullProps) {
  const { t } = useTranslation()
  const key = draftKey(pipelineId, branch)

  const cached = _draftCache.get(key)
  if (cached && cached.prepared.clonedOid !== remoteHead) _draftCache.delete(key)

  const [prepared, setPrepared] = useState<PreparedEtlPull | null>(() => _draftCache.get(key)?.prepared ?? null)
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
    prepareEtlPull(pipelineId, branch)
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
  }, [pipelineId, branch, key, remoteHead])

  useEffect(() => {
    if (prepared) _draftCache.set(key, { prepared, decisions })
  }, [key, prepared, decisions])

  const plan: PullPlan | null = useMemo(
    () => (prepared ? buildEtlPipelinePullPlan(prepared, branch) : null),
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
      // Every row is a whole-file row, so the verdict hangs off the FILE id, not
      // off an item id — reading the wrong one silently accepts nothing.
      const paths = new Set<string>()
      let settings = false
      for (const file of plan.files) {
        if (decisions.get(wholeFileId(file)) !== 'accept') continue
        if (file.path === ETL_SETTINGS_FILE) settings = true
        else paths.add(file.path)
      }
      await applyEtlPull(pipelineId, prepared, {
        paths,
        settings,
        // Taking nothing IS the resolution "keep mine" — but only when it was
        // decided, never when the user simply hasn't ticked anything yet.
        keepLocal: paths.size === 0 && !settings,
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
        onOpenDiff={setDiffPath}
        onFinalize={handleFinalize}
        applying={applying}
      />

      {diffPath && prepared && (
        <PullDiffDialog
          plan={plan}
          initialPath={diffPath}
          buildDiff={(file) => buildEtlPullDiff(file, prepared)}
          onClose={() => setDiffPath(null)}
        />
      )}
    </>
  )
}
