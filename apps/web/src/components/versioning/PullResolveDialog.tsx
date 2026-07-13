import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDownToLine, Loader2, Table2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { prepareMappingProjectPull, type PullResolution, type PreparedPull } from '@/lib/concept-mapping/pull'
import type { MappingProjectMerge } from '@/lib/concept-mapping/merge'
import { PullMappingsTable } from './PullMappingsTable'

interface PullResolveDialogProps {
  projectId: string
  branch: string
  /** The remote head the panel currently knows about. A cached draft prepared
   *  against a different head is stale (the remote advanced) and is discarded so
   *  we never apply an out-of-date merge or advance the anchor to a stale head. */
  remoteHead: string | null
  onClose: () => void
  /** Called with the prepared pull + the user's resolution when they confirm.
   *  The caller applies it (DB write + anchor) and refreshes the panel. */
  onResolve: (prepared: PreparedPull, resolution: PullResolution) => void | Promise<void>
}

// Persist the prepared merge + the user's in-progress choices across close/reopen
// (keyed by project+branch), so reopening the dialog doesn't recompute from zero
// and doesn't lose a half-made resolution. Cleared after a successful apply.
interface PullDraft {
  prepared: PreparedPull
  keptMappings: Set<string>
  mappingChoices: Record<string, 'remote' | 'local'>
  keptMeta: Set<string>
  metaChoices: Record<string, 'remote' | 'local'>
  takeSource: boolean
  takeScores: boolean
}
const _draftCache = new Map<string, PullDraft>()
const draftKey = (projectId: string, branch: string) => `${projectId}|${branch}`

function humanBytes(n?: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Entity-level pull resolution. Mappings are summarised (counts by change type)
 * with a button opening a full datatable to pick individual ones — the inline
 * list doesn't scale to hundreds. Metadata is per-field; source concepts and
 * scores are whole-list blocks. Never a raw file diff. State is cached so closing
 * and reopening keeps the fetched merge + the user's choices.
 */
export function PullResolveDialog({ projectId, branch, remoteHead, onClose, onResolve }: PullResolveDialogProps) {
  const { t } = useTranslation()
  const key = draftKey(projectId, branch)
  // Drop a cached draft prepared against a now-stale remote head before it seeds
  // any state — otherwise a remote that advanced between opens would let the user
  // apply an out-of-date merge and advance the anchor to the wrong head.
  const staleCached = _draftCache.get(key)
  if (staleCached && staleCached.prepared.remoteHead !== remoteHead) _draftCache.delete(key)

  const [prepared, setPrepared] = useState<PreparedPull | null>(() => _draftCache.get(key)?.prepared ?? null)
  const merge: MappingProjectMerge | null = prepared?.merge ?? null
  const [loading, setLoading] = useState(!_draftCache.has(key))
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [tableOpen, setTableOpen] = useState(false)

  const cached = _draftCache.get(key)
  const [keptMappings, setKeptMappings] = useState<Set<string>>(cached?.keptMappings ?? new Set())
  const [mappingChoices, setMappingChoices] = useState<Record<string, 'remote' | 'local'>>(cached?.mappingChoices ?? {})
  const [keptMeta, setKeptMeta] = useState<Set<string>>(cached?.keptMeta ?? new Set())
  const [metaChoices, setMetaChoices] = useState<Record<string, 'remote' | 'local'>>(cached?.metaChoices ?? {})
  const [takeSource, setTakeSource] = useState(cached?.takeSource ?? false)
  const [takeScores, setTakeScores] = useState(cached?.takeScores ?? false)

  useEffect(() => {
    if (_draftCache.has(key)) return // already prepared — keep the cached draft
    let cancelled = false
    setLoading(true)
    setError(null)
    prepareMappingProjectPull(projectId, branch)
      .then((p) => {
        if (cancelled) return
        setPrepared(p)
        const m = p.merge
        setKeptMappings(new Set(m.mappings.filter((c) => c.type !== 'conflict').map((c) => c.key)))
        setMappingChoices(Object.fromEntries(m.mappings.filter((c) => c.type === 'conflict').map((c) => [c.key, 'remote' as const])))
        setKeptMeta(new Set(m.metadata.cleanUpdates.map((u) => u.field)))
        setMetaChoices(Object.fromEntries(m.metadata.conflicts.map((c) => [c.field, 'remote' as const])))
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
    // remoteHead is a dep so a remote that advances while the dialog is open
    // re-runs the fetch (the stale-draft delete above already cleared the cache).
  }, [projectId, branch, key, remoteHead])

  // Persist the draft on every change so a close/reopen restores it.
  useEffect(() => {
    if (!prepared) return
    _draftCache.set(key, { prepared, keptMappings, mappingChoices, keptMeta, metaChoices, takeSource, takeScores })
  }, [key, prepared, keptMappings, mappingChoices, keptMeta, metaChoices, takeSource, takeScores])

  // Mapping counts by change type, for the summary.
  const counts = useMemo(() => {
    const c = { add: 0, update: 0, delete: 0, conflict: 0 }
    for (const ch of merge?.mappings ?? []) c[ch.type]++
    return c
  }, [merge])

  // How many mapping changes are actually selected (clean kept + conflicts→remote).
  const selectedMappingCount = useMemo(() => {
    if (!merge) return 0
    let n = 0
    for (const ch of merge.mappings) {
      if (ch.type === 'conflict') { if ((mappingChoices[ch.key] ?? 'remote') === 'remote') n++ }
      else if (keptMappings.has(ch.key)) n++
    }
    return n
  }, [merge, keptMappings, mappingChoices])

  const nothingToPull =
    merge != null &&
    merge.mappings.length === 0 &&
    merge.metadata.cleanUpdates.length === 0 &&
    merge.metadata.conflicts.length === 0 &&
    !merge.sourceConcepts.changed &&
    !merge.scores.changed

  const toggleMeta = (fieldName: string) => {
    const next = new Set(keptMeta)
    if (next.has(fieldName)) next.delete(fieldName)
    else next.add(fieldName)
    setKeptMeta(next)
  }

  const handleApply = async () => {
    if (!merge || !prepared || applying) return
    setApplying(true)
    try {
      // Selected clean mapping changes + conflicts resolved as 'remote'.
      const cleanKept = merge.mappings.filter((c) => c.type !== 'conflict' && keptMappings.has(c.key))
      await onResolve(prepared, {
        mappings: cleanKept,
        mappingConflictChoices: mappingChoices,
        metadataUpdates: merge.metadata.cleanUpdates.filter((u) => keptMeta.has(u.field)),
        metadataConflictChoices: metaChoices,
        takeRemoteSourceConcepts: takeSource,
        takeRemoteScores: takeScores,
      })
      _draftCache.delete(key) // applied → the draft is stale
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[70vh] w-[92vw] max-w-[620px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ArrowDownToLine size={16} />
            {t('versioning.pull_title')}
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
              {/* Mappings — summary + open the picker table */}
              {merge && merge.mappings.length > 0 && (
                <Section title={t('versioning.pull_section_mappings')}>
                  <div className="flex items-center justify-between gap-3 py-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      {counts.add > 0 && <Tag cls="emerald" label={t('versioning.pull_count_add', { count: counts.add })} />}
                      {counts.update > 0 && <Tag cls="sky" label={t('versioning.pull_count_update', { count: counts.update })} />}
                      {counts.delete > 0 && <Tag cls="rose" label={t('versioning.pull_count_delete', { count: counts.delete })} />}
                      {counts.conflict > 0 && <Tag cls="amber" label={t('versioning.pull_count_conflict', { count: counts.conflict })} />}
                    </div>
                    <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1 text-xs" onClick={() => setTableOpen(true)}>
                      <Table2 size={12} />
                      {t('versioning.pull_open_table')}
                    </Button>
                  </div>
                  <div className="pb-1 text-[11px] text-muted-foreground">
                    {t('versioning.pull_selected_count', { count: selectedMappingCount, total: merge.mappings.length })}
                  </div>
                </Section>
              )}

              {/* Metadata */}
              {merge && (merge.metadata.cleanUpdates.length > 0 || merge.metadata.conflicts.length > 0) && (
                <Section title={t('versioning.pull_section_metadata')}>
                  {merge.metadata.cleanUpdates.map((u) => (
                    <label key={u.field} className="flex items-center gap-2 py-1 text-xs">
                      <Checkbox checked={keptMeta.has(u.field)} onCheckedChange={() => toggleMeta(u.field)} />
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

              {/* Source concepts — whole-list block */}
              {merge?.sourceConcepts.changed && (
                <Section title={t('versioning.pull_section_source')}>
                  <label className="flex items-center gap-2 py-1 text-xs">
                    <Checkbox checked={takeSource} onCheckedChange={(v) => setTakeSource(!!v)} />
                    <span>{t('versioning.pull_source_replace_v2', { remote: describeList(merge.sourceConcepts) })}</span>
                  </label>
                </Section>
              )}

              {/* Similarity scores — remote wins block */}
              {merge?.scores.changed && (
                <Section title={t('versioning.pull_section_scores')}>
                  <label className="flex items-center gap-2 py-1 text-xs">
                    <Checkbox checked={takeScores} onCheckedChange={(v) => setTakeScores(!!v)} />
                    <span>{t('versioning.pull_scores_replace_v2', { remote: describeList(merge.scores) })}</span>
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

      {tableOpen && merge && (
        <PullMappingsTable
          changes={merge.mappings}
          selected={keptMappings}
          conflictChoices={mappingChoices}
          onClose={() => setTableOpen(false)}
          onApply={(sel, choices) => {
            setKeptMappings(sel)
            setMappingChoices(choices)
            setTableOpen(false)
          }}
        />
      )}
    </Dialog>
  )
}

/** Human label for a whole-list family: row count if known, else size / "LFS". */
function describeList(s: { remoteCount: number; remoteByteSize?: number; remoteLfs?: boolean }): string {
  if (s.remoteCount > 0) return `${s.remoteCount}`
  if (s.remoteByteSize) return humanBytes(s.remoteByteSize)
  return s.remoteLfs ? 'LFS' : '?'
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="rounded-md border px-3 py-1">{children}</div>
    </div>
  )
}

function Tag({ cls, label }: { cls: 'emerald' | 'sky' | 'rose' | 'amber'; label: string }) {
  const map = {
    emerald: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    sky: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    rose: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  }
  return <span className={cn('rounded px-1.5 py-0.5 font-semibold', map[cls])}>{label}</span>
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
