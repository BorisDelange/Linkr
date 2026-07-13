import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDownToLine, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { prepareMappingProjectPull } from '@/lib/concept-mapping/pull'
import type { MappingProjectMerge, MappingChange } from '@/lib/concept-mapping/merge'
import type { ConceptMapping } from '@/types'

export interface PullResolution {
  /** Clean remote changes (add/update/delete) the user kept, by mapping key. */
  mappings: MappingChange[]
  /** For each conflicted mapping key: 'remote' (take theirs) or 'local' (keep mine). */
  mappingConflictChoices: Record<string, 'remote' | 'local'>
  /** Clean metadata field updates to apply. */
  metadataUpdates: { field: string; value: unknown }[]
  /** For each conflicted metadata field: 'remote' or 'local'. */
  metadataConflictChoices: Record<string, 'remote' | 'local'>
  /** Whether to take the remote source-concepts list. */
  takeRemoteSourceConcepts: boolean
  /** Whether to take the remote similarity scores. */
  takeRemoteScores: boolean
}

interface PullResolveDialogProps {
  projectId: string
  branch: string
  onClose: () => void
  /** Called with the user's resolution when they confirm. (Sub-step 3 wires the
   *  DB write; for now the dialog just hands back the plan and closes.) */
  onResolve: (resolution: PullResolution) => void | Promise<void>
}

/** Short "source → target" label for a mapping, for the change list. */
function mappingLabel(m: ConceptMapping | null): string {
  if (!m) return '—'
  const src = m.sourceConceptName || m.sourceConceptCode || String(m.sourceConceptId)
  const tgt = m.targetConceptName || m.targetConceptCode || String(m.targetConceptId)
  return `${src} → ${tgt}`
}

/**
 * Entity-level pull resolution: shows what the remote changed (mappings by
 * source→target, metadata by field, source-concepts / scores as whole-list
 * blocks) and lets the user apply clean changes and pick a side per conflict —
 * never a raw file diff. See docs/planning/git-pull-sync-plan.md §3.3.
 */
export function PullResolveDialog({ projectId, branch, onClose, onResolve }: PullResolveDialogProps) {
  const { t } = useTranslation()
  const [merge, setMerge] = useState<MappingProjectMerge | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  // User choices.
  const [keptClean, setKeptClean] = useState<Set<string>>(new Set())
  const [mappingChoices, setMappingChoices] = useState<Record<string, 'remote' | 'local'>>({})
  const [keptMeta, setKeptMeta] = useState<Set<string>>(new Set())
  const [metaChoices, setMetaChoices] = useState<Record<string, 'remote' | 'local'>>({})
  const [takeSource, setTakeSource] = useState(false)
  const [takeScores, setTakeScores] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    prepareMappingProjectPull(projectId, branch)
      .then((m) => {
        if (cancelled) return
        setMerge(m)
        // Default: keep every clean change + take remote blocks; conflicts default
        // to "remote" (their pushed version) but the user can flip per item.
        setKeptClean(new Set(m.mappings.filter((c) => c.type !== 'conflict').map((c) => c.key)))
        setMappingChoices(Object.fromEntries(m.mappings.filter((c) => c.type === 'conflict').map((c) => [c.key, 'remote'])))
        setKeptMeta(new Set(m.metadata.cleanUpdates.map((u) => u.field)))
        setMetaChoices(Object.fromEntries(m.metadata.conflicts.map((c) => [c.field, 'remote'])))
        setTakeSource(m.sourceConcepts.changed)
        setTakeScores(m.scores.changed)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [projectId, branch])

  const clean = useMemo(() => (merge?.mappings ?? []).filter((c) => c.type !== 'conflict'), [merge])
  const conflicts = useMemo(() => (merge?.mappings ?? []).filter((c) => c.type === 'conflict'), [merge])

  const nothingToPull =
    merge != null &&
    merge.mappings.length === 0 &&
    merge.metadata.cleanUpdates.length === 0 &&
    merge.metadata.conflicts.length === 0 &&
    !merge.sourceConcepts.changed &&
    !merge.scores.changed

  const toggle = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }

  const handleApply = async () => {
    if (!merge || applying) return
    setApplying(true)
    try {
      await onResolve({
        mappings: clean.filter((c) => keptClean.has(c.key)),
        mappingConflictChoices: mappingChoices,
        metadataUpdates: merge.metadata.cleanUpdates.filter((u) => keptMeta.has(u.field)),
        metadataConflictChoices: metaChoices,
        takeRemoteSourceConcepts: takeSource,
        takeRemoteScores: takeScores,
      })
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[85vh] w-[92vw] max-w-[900px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ArrowDownToLine size={16} />
            {t('versioning.pull_title')}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {t('versioning.pull_computing')}
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-destructive">
            <AlertTriangle size={24} />
            {error}
          </div>
        ) : nothingToPull ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t('versioning.pull_nothing')}
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-5 p-4">
              {/* Metadata */}
              {merge && (merge.metadata.cleanUpdates.length > 0 || merge.metadata.conflicts.length > 0) && (
                <Section title={t('versioning.pull_section_metadata')}>
                  {merge.metadata.cleanUpdates.map((u) => (
                    <label key={u.field} className="flex items-center gap-2 py-1 text-xs">
                      <Checkbox checked={keptMeta.has(u.field)} onCheckedChange={() => toggle(keptMeta, u.field, setKeptMeta)} />
                      <span className="font-medium">{u.field}</span>
                      <span className="text-muted-foreground">{t('versioning.pull_apply_remote')}</span>
                    </label>
                  ))}
                  {merge.metadata.conflicts.map((c) => (
                    <ConflictRow
                      key={c.field}
                      label={c.field}
                      mineLabel={t('versioning.pull_keep_mine')}
                      theirsLabel={t('versioning.pull_take_theirs')}
                      choice={metaChoices[c.field] ?? 'remote'}
                      onChoice={(v) => setMetaChoices((s) => ({ ...s, [c.field]: v }))}
                      mine={JSON.stringify(c.local)}
                      theirs={JSON.stringify(c.remote)}
                    />
                  ))}
                </Section>
              )}

              {/* Mappings — clean */}
              {clean.length > 0 && (
                <Section title={t('versioning.pull_section_mappings')}>
                  {clean.map((c) => (
                    <label key={c.key} className="flex items-center gap-2 py-1 text-xs">
                      <Checkbox checked={keptClean.has(c.key)} onCheckedChange={() => toggle(keptClean, c.key, setKeptClean)} />
                      <ChangeTag type={c.type} />
                      <span className="truncate">{mappingLabel(c.remote ?? c.local)}</span>
                    </label>
                  ))}
                </Section>
              )}

              {/* Mappings — conflicts */}
              {conflicts.length > 0 && (
                <Section title={t('versioning.pull_section_conflicts')}>
                  {conflicts.map((c) => (
                    <ConflictRow
                      key={c.key}
                      label={mappingLabel(c.local ?? c.remote)}
                      mineLabel={t('versioning.pull_keep_mine')}
                      theirsLabel={t('versioning.pull_take_theirs')}
                      choice={mappingChoices[c.key] ?? 'remote'}
                      onChoice={(v) => setMappingChoices((s) => ({ ...s, [c.key]: v }))}
                      mine={c.local ? `${c.local.status} · ${mappingLabel(c.local)}` : t('versioning.pull_deleted')}
                      theirs={c.remote ? `${c.remote.status} · ${mappingLabel(c.remote)}` : t('versioning.pull_deleted')}
                    />
                  ))}
                </Section>
              )}

              {/* Source concepts — whole-list block */}
              {merge?.sourceConcepts.changed && (
                <Section title={t('versioning.pull_section_source')}>
                  <label className="flex items-center gap-2 py-1 text-xs">
                    <Checkbox checked={takeSource} onCheckedChange={(v) => setTakeSource(!!v)} />
                    <span>{t('versioning.pull_source_replace', { local: merge.sourceConcepts.localCount, remote: merge.sourceConcepts.remoteCount })}</span>
                  </label>
                </Section>
              )}

              {/* Similarity scores — remote wins block */}
              {merge?.scores.changed && (
                <Section title={t('versioning.pull_section_scores')}>
                  <label className="flex items-center gap-2 py-1 text-xs">
                    <Checkbox checked={takeScores} onCheckedChange={(v) => setTakeScores(!!v)} />
                    <span>{t('versioning.pull_scores_replace', { remote: merge.scores.remoteCount })}</span>
                  </label>
                </Section>
              )}
            </div>
          </ScrollArea>
        )}

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={applying}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleApply} disabled={loading || !!error || nothingToPull || applying} className="gap-1.5">
            {applying ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}
            {t('versioning.pull_apply')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="rounded-md border px-3 py-1">{children}</div>
    </div>
  )
}

function ChangeTag({ type }: { type: MappingChange['type'] }) {
  const { t } = useTranslation()
  const cls: Record<string, string> = {
    add: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    update: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    delete: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    conflict: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  }
  return (
    <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase', cls[type])}>
      {t(`versioning.pull_change_${type}`)}
    </span>
  )
}

function ConflictRow({
  label, mineLabel, theirsLabel, choice, onChoice, mine, theirs,
}: {
  label: string
  mineLabel: string
  theirsLabel: string
  choice: 'remote' | 'local'
  onChoice: (v: 'remote' | 'local') => void
  mine: string
  theirs: string
}) {
  return (
    <div className="flex flex-col gap-1 border-b py-2 last:border-0">
      <div className="truncate text-xs font-medium">{label}</div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onChoice('local')}
          className={cn('rounded border px-2 py-1 text-left text-[11px]', choice === 'local' ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground')}
        >
          <div className="font-semibold">{mineLabel}</div>
          <div className="truncate">{mine}</div>
        </button>
        <button
          type="button"
          onClick={() => onChoice('remote')}
          className={cn('rounded border px-2 py-1 text-left text-[11px]', choice === 'remote' ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground')}
        >
          <div className="font-semibold">{theirsLabel}</div>
          <div className="truncate">{theirs}</div>
        </button>
      </div>
    </div>
  )
}
