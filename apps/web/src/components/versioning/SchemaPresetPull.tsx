import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  applySchemaPresetPull,
  prepareSchemaPresetPull,
  type PreparedSchemaPresetPull,
} from '@/lib/schema-preset-pull'
import { buildSchemaPresetPullPlan } from '@/lib/schema-preset-pull-plan-builder'
import { wholeFileId, type PullDecision, type PullPlan } from '@/lib/pull-plan'
import { PullPanel } from './PullPanel'

interface SchemaPresetPullProps {
  presetId: string
  branch: string
  /** The remote head the panel knows about — a plan prepared against a different
   *  one is stale (the remote advanced) and must be recomputed. */
  remoteHead: string | null
  mode: 'quick' | 'details'
  /** Called once the pull is applied so the panel refreshes status + cursors. */
  onPulled: () => void | Promise<void>
}

/** Draft decisions survive closing the tab, so a half-made review isn't lost.
 *  Keyed by preset+branch and dropped when the remote head moves. */
interface PullDraft {
  prepared: PreparedSchemaPresetPull
  decisions: Map<string, PullDecision>
}
const _draftCache = new Map<string, PullDraft>()
const draftKey = (presetId: string, branch: string) => `${presetId}|${branch}`

/**
 * The schema-preset pull, rendered inline where the push list normally sits — the
 * same shell as the ETL pull, over a different plan builder.
 *
 * No diff viewer: every row is a whole block taken or left, so there is no merge
 * projection to read that the row's own label does not already say.
 */
export function SchemaPresetPull({ presetId, branch, remoteHead, mode, onPulled }: SchemaPresetPullProps) {
  const { t } = useTranslation()
  const key = draftKey(presetId, branch)

  const cached = _draftCache.get(key)
  if (cached && cached.prepared.clonedOid !== remoteHead) _draftCache.delete(key)

  const [prepared, setPrepared] = useState<PreparedSchemaPresetPull | null>(
    () => _draftCache.get(key)?.prepared ?? null,
  )
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
    prepareSchemaPresetPull(presetId, branch)
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
  }, [presetId, branch, key, remoteHead])

  useEffect(() => {
    if (prepared) _draftCache.set(key, { prepared, decisions })
  }, [key, prepared, decisions])

  const plan: PullPlan | null = useMemo(
    () => (prepared ? buildSchemaPresetPullPlan(prepared, branch) : null),
    [prepared, branch],
  )

  const decide = (ids: string[], decision: PullDecision) => {
    setDecisions((prev) => {
      const next = new Map(prev)
      for (const id of ids) next.set(id, decision)
      return next
    })
  }

  // The panel's `complete` is deliberately ignored: which cursor may advance is
  // derived inside applySchemaPresetPull from the same selection, so taking it
  // from here too would be a second, independently-computed answer to one question.
  const handleFinalize = async () => {
    if (!prepared || !plan || applying) return
    setApplying(true)
    setError(null)
    try {
      // Every row is a whole-file row, so the verdict hangs off the FILE id.
      const paths = new Set<string>()
      for (const file of plan.files) {
        if (decisions.get(wholeFileId(file)) === 'accept') paths.add(file.path)
      }
      await applySchemaPresetPull(presetId, prepared, {
        paths,
        // Taking nothing IS the resolution "keep mine" — but only when it was
        // decided, never when the user simply hasn't ticked anything yet.
        keepLocal: paths.size === 0,
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
