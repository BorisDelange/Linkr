import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDownToLine, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { gitThreeWay, type GitScope } from '@/lib/api/git'
import { itemIdFor, planIsEmpty, type PullDecision, type PullFile, type PullPlan } from '@/lib/pull-plan'
import {
  buildThreeWayPlan,
  mergedContent,
  prepareThreeWay,
  type PreparedFile,
  type ThreeWayPreview,
} from '@/lib/pull/three-way'
import { elementLabels, wikiTitles } from '@/lib/pull/element-label'
import { splitUnwritable } from '@/lib/pull/apply'
import { finalizePull } from '@/lib/pull/run'
import { groupWikiPages } from '@/lib/pull/wiki-pages'
import { useAppStore } from '@/stores/app-store'
import { useAuthStore } from '@/stores/auth-store'
import type { PullDiffText } from '@/lib/concept-mapping/pull-diff'
import { PullPanel } from './PullPanel'
import { PullDiffDialog } from './PullDiffDialog'

interface ThreeWayPullProps {
  scope: GitScope
  /** The entity's id in its scope (a project's uid). */
  id: string
  workspaceId?: string
  branch: string
  remoteHead: string | null
  mode: 'quick' | 'details'
  onPulled: () => void | Promise<void>
}

interface Draft {
  preview: ThreeWayPreview
  prepared: PreparedFile[]
  unsupported: string[]
  decisions: Map<string, PullDecision>
  /** Results written by hand in the diff, by path. */
  edits: Map<string, string>
}
const _drafts = new Map<string, Draft>()

/**
 * The pull of any versioned entity, inline in its versioning panel: what the
 * remote changed since the last sync, file by file and item by item, merged with
 * the local edits where they do not overlap (plan §9.2). Finalizing re-imports the
 * merged tree and moves the sync cursors — the content one only when everything
 * on offer was taken.
 */
export function ThreeWayPull({ scope, id, workspaceId, branch, remoteHead, mode, onPulled }: ThreeWayPullProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const key = `${scope}|${id}|${branch}`
  const cached = _drafts.get(key)
  if (cached && cached.preview.remoteHead !== remoteHead) _drafts.delete(key)

  const [draft, setDraft] = useState<Draft | null>(() => _drafts.get(key) ?? null)
  const [loading, setLoading] = useState(!_drafts.has(key))
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [diffPath, setDiffPath] = useState<string | null>(null)

  useEffect(() => {
    if (_drafts.has(key)) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      const preview = await gitThreeWay(scope, id, branch)
      const { prepared, unsupported } = splitUnwritable(scope, prepareThreeWay(preview), useAuthStore.getState().user?.username)
      return { preview, prepared, unsupported, decisions: new Map<string, PullDecision>(), edits: new Map<string, string>() }
    })()
      .then((d) => { if (!cancelled) { setDraft(d); setLoading(false) } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [key, scope, id, branch, remoteHead])

  useEffect(() => { if (draft) _drafts.set(key, draft) }, [key, draft])

  const supported = useMemo(() => draft?.prepared ?? [], [draft])

  // `real` is the plan as the merged tree reads it; the panel shows `plan`, where
  // a wiki page's settings ride on its text row (groupWikiPages).
  const views = useMemo(() => {
    if (!draft) return null
    const labels = elementLabels(draft.preview.files, language, t)
    const titles = wikiTitles(draft.preview.files, language)
    const built = buildThreeWayPlan(scope, draft.preview, supported, {
      file: t('versioning.pull_file'),
      field: (field) => field,
      element: (k) => titles.get(k) ?? k,
      merged: t('versioning.pull_merged'),
    })
    const real: PullPlan = {
      ...built,
      files: built.files.map((f) => ({
        ...f,
        label: labels.get(f.path),
        items: draft.edits.has(f.path) ? f.items.map((i) => ({ ...i, detail: t('versioning.pull_edited') })) : f.items,
      })),
    }
    const grouped = scope === 'workspaces'
      ? groupWikiPages(real, draft.preview.files, t('versioning.pull_page_settings'), (field) => t(`versioning.page_field_${field}`))
      : { plan: real, toReal: (d: Map<string, PullDecision>) => d }
    return { real, ...grouped }
  }, [draft, supported, scope, language, t])
  const plan = views?.plan ?? null

  const decide = (ids: string[], decision: PullDecision) => {
    setDraft((prev) => {
      if (!prev) return prev
      const decisions = new Map(prev.decisions)
      for (const i of ids) decisions.set(i, decision)
      return { ...prev, decisions }
    })
  }

  // A result written by hand is what the pull takes for that file.
  const edit = (path: string, text: string | null) => {
    setDraft((prev) => {
      if (!prev) return prev
      const edits = new Map(prev.edits)
      const decisions = new Map(prev.decisions)
      if (text === null) edits.delete(path)
      else {
        edits.set(path, text)
        for (const item of plan?.files.find((f) => f.path === path)?.items ?? []) decisions.set(itemIdFor(path, item.key), 'accept')
      }
      return { ...prev, edits, decisions }
    })
  }

  const finalize = async () => {
    if (!draft || !views || applying || !draft.preview.remoteHead) return
    setApplying(true)
    setError(null)
    try {
      await finalizePull({
        scope, id, workspaceId, branch, preview: draft.preview, prepared: supported, plan: views.real,
        decisions: views.toReal(draft.decisions), unsupported: draft.unsupported, edits: draft.edits,
      })
      _drafts.delete(key)
      await onPulled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      _drafts.delete(key)
    } finally {
      setApplying(false)
    }
  }

  const buildDiff = (file: PullFile): PullDiffText => {
    const prepared = draft?.prepared.find((p) => p.file.path === file.path)
    if (!prepared) return { oldContent: '', newContent: '', language: 'plaintext' }
    if (prepared.merge.kind === 'whole') return { oldContent: '', newContent: '', language: 'plaintext', notice: 'whole_file' }
    const all = new Map(file.items.map((i) => [itemIdFor(file.path, i.key), 'accept' as PullDecision]))
    const after = mergedContent(prepared, all)
    const local = prepared.file.local ?? ''
    const newContent = draft?.edits.get(file.path)
      ?? (!after ? local : 'delete' in after ? '' : 'text' in after ? after.text : prepared.file.remote ?? '')
    const language = /\.md$/i.test(file.path) ? 'markdown' : /\.json$/i.test(file.path) ? 'json'
      : /\.sql$/i.test(file.path) ? 'sql' : /\.py$/i.test(file.path) ? 'python' : /\.r$/i.test(file.path) ? 'r' : 'plaintext'
    return { oldContent: local, newContent, language }
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
  if (!plan || !draft) return null

  return (
    <>
      {error && (
        <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
      )}
      {draft.unsupported.length > 0 && (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          <div className="min-w-0">
            <p>{t('versioning.pull_unsupported', { count: draft.unsupported.length })}</p>
            <p className="mt-1 truncate font-mono text-[10px] opacity-80" title={draft.unsupported.join('\n')}>
              {draft.unsupported.slice(0, 4).join(' · ')}{draft.unsupported.length > 4 ? ' …' : ''}
            </p>
          </div>
        </div>
      )}
      {planIsEmpty(plan) ? (
        // Nothing to decide yet behind: without acknowledging the remote commit
        // the push would stay blocked.
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center text-sm text-muted-foreground">
          {t('versioning.pull_nothing_to_take')}
          <Button size="sm" className="gap-1.5" onClick={() => void finalize()} disabled={applying}>
            {applying ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}
            {t('versioning.ws_pull_acknowledge')}
          </Button>
        </div>
      ) : (
        <PullPanel
          plan={plan}
          decisions={draft.decisions}
          onDecide={decide}
          mode={mode}
          onOpenDiff={setDiffPath}
          onFinalize={finalize}
          applying={applying}
        />
      )}
      {diffPath && (
        <PullDiffDialog
          plan={plan}
          initialPath={diffPath}
          buildDiff={buildDiff}
          onClose={() => setDiffPath(null)}
          onEdit={edit}
          edited={new Set(draft.edits.keys())}
        />
      )}
    </>
  )
}
