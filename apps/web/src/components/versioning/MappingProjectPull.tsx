import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { prepareMappingProjectPull, applyMappingProjectPull, type PreparedPull } from '@/lib/concept-mapping/pull'
import { buildMappingProjectPullPlan } from '@/lib/concept-mapping/pull-plan-builder'
import { itemId, itemIdFor, wholeFileId, type PullDecision, type PullFile, type PullPlan } from '@/lib/pull-plan'
import type { MappingChange } from '@/lib/concept-mapping/merge'
import { buildPullDiff } from '@/lib/concept-mapping/pull-diff'
import { PullPanel } from './PullPanel'
import { PullDiffDialog } from './PullDiffDialog'
import { PullMappingsTable } from './PullMappingsTable'
import { PullConceptsDialog } from './PullConceptsDialog'

interface MappingProjectPullProps {
  projectId: string
  branch: string
  /** The remote head the panel knows about — a plan prepared against a different
   *  one is stale (the remote advanced) and must be recomputed. */
  remoteHead: string | null
  mode: 'quick' | 'details'
  /** Called once the pull is applied so the panel refreshes status + cursors. */
  onPulled: () => void | Promise<void>
}

/** Draft decisions survive closing the tab, so a half-made review isn't lost.
 *  Keyed by project+branch and dropped when the remote head moves (the plan it
 *  was made against no longer exists) or once applied. */
interface PullDraft {
  prepared: PreparedPull
  decisions: Map<string, PullDecision>
}
const _draftCache = new Map<string, PullDraft>()
const draftKey = (projectId: string, branch: string) => `${projectId}|${branch}`

/**
 * The mapping-project pull, rendered inline where the push list normally sits.
 *
 * Owns the merge and the user's verdicts; `PullPanel` renders them. Applying maps
 * each accepted item back to its business-object applier — the file was only ever
 * the handle the user ticked.
 */
export function MappingProjectPull({ projectId, branch, remoteHead, mode, onPulled }: MappingProjectPullProps) {
  const { t } = useTranslation()
  const key = draftKey(projectId, branch)

  // Drop a draft prepared against a stale head before it seeds any state: its
  // plan describes a commit that is no longer the remote's tip, so applying it
  // would advance a cursor to the wrong place.
  const cached = _draftCache.get(key)
  if (cached && cached.prepared.remoteHead !== remoteHead) _draftCache.delete(key)

  const [prepared, setPrepared] = useState<PreparedPull | null>(() => _draftCache.get(key)?.prepared ?? null)
  const [decisions, setDecisions] = useState<Map<string, PullDecision>>(
    () => new Map(_draftCache.get(key)?.decisions ?? []),
  )
  const [loading, setLoading] = useState(!_draftCache.has(key))
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [tableFile, setTableFile] = useState<PullFile | null>(null)
  const [diffPath, setDiffPath] = useState<string | null>(null)
  // Source-concept keys whose remote change was refused. Kept beside the file-level
  // verdicts because they are finer than one: the CSV is written as a block, but
  // the applier rebuilds that block around these refusals.
  const [declinedConcepts, setDeclinedConcepts] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (_draftCache.has(key)) return
    let cancelled = false
    setLoading(true)
    setError(null)
    prepareMappingProjectPull(projectId, branch)
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
  }, [projectId, branch, key, remoteHead])

  // Persist the draft on every change so switching tabs keeps the review.
  useEffect(() => {
    if (prepared) _draftCache.set(key, { prepared, decisions })
  }, [key, prepared, decisions])

  const plan: PullPlan | null = useMemo(
    () => (prepared ? buildMappingProjectPullPlan(prepared, branch) : null),
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
      await applyMappingProjectPull(
        projectId,
        branch,
        prepared,
        buildResolution(plan, prepared, decisions, complete, declinedConcepts),
      )
      _draftCache.delete(key)
      await onPulled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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

  // The mappings table drives the same decision map as the rows, so a choice made
  // in either place is the same choice — not two selections to reconcile.
  const mappingChanges: MappingChange[] = prepared?.merge.mappings ?? []
  const tableIsMappings = tableFile?.path === 'mappings.json'
  const tableIsConcepts = tableFile?.path === 'source-concepts.csv'

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
        onOpenTable={setTableFile}
        onFinalize={handleFinalize}
        applying={applying}
      />

      {diffPath && prepared && (
        <PullDiffDialog
          plan={plan}
          initialPath={diffPath}
          buildDiff={(file) => buildPullDiff(file, prepared.merge, prepared.sourceConceptsDiff)}
          onClose={() => setDiffPath(null)}
        />
      )}

      {tableIsMappings && (
        <PullMappingsTable
          changes={mappingChanges}
          // Everything ticked until the user says otherwise: taking the remote
          // changes is the reason they opened the pull, so the table starts from
          // "take it all" and unticking is the deliberate act. An untouched row
          // still counts as decided only once they confirm (see onApply).
          selected={new Set(
            mappingChanges
              .filter((c) => decisions.get(itemIdFor('mappings.json', c.key)) !== 'decline')
              .map((c) => c.key),
          )}
          conflictChoices={{}}
          onClose={() => setTableFile(null)}
          onApply={(selected) => {
            // Every row the table showed is now decided: picked = accept, left
            // unticked = decline. The table IS the deliberation, so closing it
            // with a verdict on each row is what lets the pull finalize.
            setDecisions((prev) => {
              const next = new Map(prev)
              for (const change of mappingChanges) {
                next.set(itemIdFor('mappings.json', change.key), selected.has(change.key) ? 'accept' : 'decline')
              }
              return next
            })
            setTableFile(null)
          }}
        />
      )}

      {tableIsConcepts && tableFile && (
        <PullConceptsDialog
          diff={prepared?.sourceConceptsDiff}
          changes={prepared?.sourceConceptsDiff?.changes ?? []}
          declined={declinedConcepts}
          onClose={() => setTableFile(null)}
          onApply={(nextDeclined) => {
            setDeclinedConcepts(nextDeclined)
            // The file's own verdict: refusing EVERY change is "keep mine", any
            // other outcome means we write a list (the remote's, or the remote's
            // minus what was refused).
            const all = prepared?.sourceConceptsDiff?.changes ?? []
            const keepAllMine = nextDeclined.has('*') || (all.length > 0 && all.every((c) => nextDeclined.has(c.key)))
            decide(
              tableFile.wholeFile
                ? [wholeFileId(tableFile)]
                : tableFile.items.map((i) => itemId(tableFile, i)),
              keepAllMine ? 'decline' : 'accept',
            )
            setTableFile(null)
          }}
        />
      )}
    </>
  )
}

/**
 * Map the user's per-item verdicts back onto the business-object resolution.
 *
 * The file was the handle; here we resolve it to the units the appliers speak —
 * mapping changes, metadata fields, the source list.
 */
function buildResolution(
  plan: PullPlan,
  prepared: PreparedPull,
  decisions: Map<string, PullDecision>,
  complete: boolean,
  declinedConcepts: ReadonlySet<string>,
) {
  const accepted = (path: string, key: string) => decisions.get(itemIdFor(path, key)) === 'accept'

  const mappings = prepared.merge.mappings.filter(
    (c) => c.type !== 'conflict' && accepted('mappings.json', c.key),
  )
  const mappingConflictChoices: Record<string, 'remote' | 'local'> = {}
  for (const c of prepared.merge.mappings) {
    if (c.type === 'conflict') {
      mappingConflictChoices[c.key] = accepted('mappings.json', c.key) ? 'remote' : 'local'
    }
  }

  // A metadata field lives under project.json unless it has its own file
  // (README/LICENSE), which is where the plan listed it.
  const fieldPath = (field: string): string => {
    const owner = plan.files.find((f) => f.items.some((i) => i.key === field))
    return owner?.path ?? 'project.json'
  }
  const metadataUpdates = prepared.merge.metadata.cleanUpdates.filter((u) =>
    accepted(fieldPath(u.field), u.field),
  )
  const metadataConflictChoices: Record<string, 'remote' | 'local'> = {}
  for (const c of prepared.merge.metadata.conflicts) {
    metadataConflictChoices[c.field] = accepted(fieldPath(c.field), c.field) ? 'remote' : 'local'
  }

  // Source concepts are replaced wholesale: taking any part of the incoming list
  // means writing the remote CSV, since we can't splice rows into it.
  const sourceFile = plan.files.find((f) => f.path === 'source-concepts.csv')
  const takeRemoteSourceConcepts = sourceFile
    ? sourceFile.wholeFile
      ? decisions.get(wholeFileId(sourceFile)) === 'accept'
      : sourceFile.items.some((i) => decisions.get(itemId(sourceFile, i)) === 'accept')
    : false

  return {
    mappings,
    mappingConflictChoices,
    metadataUpdates,
    metadataConflictChoices,
    takeRemoteSourceConcepts,
    // '*' is the whole-file "keep mine" marker, which never reaches the applier:
    // it is expressed by takeRemoteSourceConcepts being false.
    declinedSourceConcepts: new Set([...declinedConcepts].filter((k) => k !== '*')),
    complete,
  }
}
