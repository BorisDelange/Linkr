import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDownToLine, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getStorage } from '@/lib/storage'
import { gitSetSyncState, gitTreePreview } from '@/lib/api/git'
import { localized, toLocalized } from '@/lib/localized'
import { isCompletePull, planIsEmpty, type PullDecision, type PullFile, type PullPlan } from '@/lib/pull-plan'
import {
  applyWikiPull,
  buildWikiPullPlan,
  pageAfterPull,
  prepareWikiPull,
  WIKI_PREFIX,
  type PreparedWikiPull,
} from '@/lib/wiki/wiki-pull'
import { useAppStore } from '@/stores/app-store'
import { useWikiStore } from '@/stores/wiki-store'
import type { LocalizedString, WikiPage } from '@/types'
import type { PullDiffText } from '@/lib/concept-mapping/pull-diff'
import { PullPanel } from './PullPanel'
import { PullDiffDialog } from './PullDiffDialog'

interface WorkspacePullProps {
  workspaceId: string
  branch: string
  remoteHead: string | null
  mode: 'quick' | 'details'
  onPulled: () => void | Promise<void>
}

interface PullDraft {
  prepared: PreparedWikiPull
  decisions: Map<string, PullDecision>
}
const _draftCache = new Map<string, PullDraft>()

/**
 * The workspace pull, inline in the versioning panel. v1 takes the wiki: one row
 * per page, one item per field or language the remote changed. Remote changes
 * elsewhere in the workspace are listed but not taken yet.
 */
export function WorkspacePull({ workspaceId, branch, remoteHead, mode, onPulled }: WorkspacePullProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const key = `${workspaceId}|${branch}`

  const cached = _draftCache.get(key)
  if (cached && cached.prepared.remoteHead !== remoteHead) _draftCache.delete(key)

  const [prepared, setPrepared] = useState<PreparedWikiPull | null>(() => _draftCache.get(key)?.prepared ?? null)
  const [decisions, setDecisions] = useState<Map<string, PullDecision>>(() => new Map(_draftCache.get(key)?.decisions ?? []))
  const [loading, setLoading] = useState(!_draftCache.has(key))
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [localPages, setLocalPages] = useState<WikiPage[]>([])

  useEffect(() => {
    if (_draftCache.has(key)) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([gitTreePreview('workspaces', workspaceId, WIKI_PREFIX, branch), getStorage().wikiPages.getByWorkspace(workspaceId)])
      .then(([preview, pages]) => {
        if (cancelled) return
        setLocalPages(pages)
        setPrepared(prepareWikiPull(preview, pages))
        setDecisions(new Map())
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [workspaceId, branch, key, remoteHead])

  useEffect(() => {
    if (prepared) _draftCache.set(key, { prepared, decisions })
  }, [key, prepared, decisions])

  const plan: PullPlan | null = useMemo(() => (prepared ? buildWikiPullPlan(prepared, branch, {
    page: t('versioning.ws_pull_page'),
    field: (f) => t(`versioning.ws_pull_field_${f}`),
    content: (lang) => t('versioning.ws_pull_content', { lang: lang.toUpperCase() }),
    autoMerged: t('versioning.ws_pull_auto_merged'),
  }) : null), [prepared, branch, t])

  const decide = (ids: string[], decision: PullDecision) => {
    setDecisions((prev) => {
      const next = new Map(prev)
      for (const id of ids) next.set(id, decision)
      return next
    })
  }

  const finalize = async () => {
    if (!prepared || !plan || applying || !prepared.remoteHead) return
    setApplying(true)
    setError(null)
    try {
      const store = useWikiStore.getState()
      await applyWikiPull(prepared, decisions, workspaceId, {
        create: (page) => getStorage().wikiPages.create(page),
        update: (id, changes) => getStorage().wikiPages.update(id, changes),
        // Not the store's deletePage, which takes the sub-pages along: here each
        // page removed upstream is its own decision.
        delete: async (id) => {
          await getStorage().wikiAttachments.deleteByPage(id)
          await getStorage().wikiPages.delete(id)
        },
      })
      // Content outside the wiki is not taken yet, so claiming the commit's content
      // would bury those changes: only the decision cursor moves then.
      const complete = isCompletePull(plan, decisions) && prepared.otherChanges.length === 0
      await gitSetSyncState('workspaces', workspaceId, branch, prepared.remoteHead, !complete)
      await store.loadPages(workspaceId)
      _draftCache.delete(key)
      await onPulled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      _draftCache.delete(key)
    } finally {
      setApplying(false)
    }
  }

  const titlesById = useMemo(() => {
    const titles = new Map<string, LocalizedString>()
    for (const p of prepared?.pages ?? []) {
      if (p.local) titles.set(p.id, toLocalized(p.local.title))
      else if (p.remote) titles.set(p.id, p.remote.meta.title)
    }
    for (const p of localPages) titles.set(p.id, toLocalized(p.title))
    return titles
  }, [prepared, localPages])
  const buildDiff = (file: PullFile): PullDiffText => {
    const page = prepared?.pages.find((p) => p.path === file.path)
    if (!page) return { oldContent: '', newContent: '', language: 'markdown' }
    const titleOf = (id: string | null | undefined) => (id ? localized(titlesById.get(id) ?? id, language) : '—')
    const render = (meta: Partial<WikiPage> | undefined, content: LocalizedString | undefined) => {
      if (!meta) return ''
      const lines = [
        `${t('versioning.ws_pull_field_title')}: ${localized(toLocalized(meta.title), language)}`,
        `${t('versioning.ws_pull_field_status')}: ${t(`wiki.status_${meta.status ?? 'draft'}`)}`,
        `${t('versioning.ws_pull_field_parentId')}: ${titleOf(meta.parentId)}`,
        `${t('versioning.ws_pull_field_icon')}: ${meta.icon ?? '—'}`,
        `${t('versioning.ws_pull_field_sortOrder')}: ${meta.sortOrder ?? 0}`,
        `${t('versioning.ws_pull_field_owner')}: ${meta.owner ?? '—'}`,
      ]
      for (const [lang, text] of Object.entries(content ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push('', `<!-- ${t('versioning.ws_pull_content', { lang: lang.toUpperCase() })} -->`, '', text.trimEnd())
      }
      return lines.join('\n') + '\n'
    }
    const after = pageAfterPull(page)
    return {
      oldContent: page.local ? render(page.local, toLocalized(page.local.content)) : '',
      newContent: after ? render(after.meta, after.content) : '',
      language: 'markdown',
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
  if (!plan || !prepared) return null

  const otherChanges = prepared.otherChanges.length > 0 && (
    <div className="mb-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
      <AlertTriangle size={14} className="mt-px shrink-0" />
      <div className="min-w-0">
        <p>{t('versioning.ws_pull_other_changes', { count: prepared.otherChanges.length })}</p>
        <p className="mt-1 truncate font-mono text-[10px] opacity-80" title={prepared.otherChanges.join('\n')}>
          {prepared.otherChanges.slice(0, 4).join(' · ')}{prepared.otherChanges.length > 4 ? ' …' : ''}
        </p>
      </div>
    </div>
  )

  return (
    <>
      {error && (
        <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {otherChanges}
      {planIsEmpty(plan) ? (
        // Nothing in the wiki to decide, yet the panel is behind: without a way
        // to acknowledge the remote commit the push would stay blocked.
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center text-sm text-muted-foreground">
          {t('versioning.ws_pull_nothing_in_wiki')}
          <Button size="sm" className="gap-1.5" onClick={() => void finalize()} disabled={applying}>
            {applying ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}
            {t('versioning.ws_pull_acknowledge')}
          </Button>
        </div>
      ) : (
        <PullPanel
          plan={plan}
          decisions={decisions}
          onDecide={decide}
          mode={mode}
          onOpenDiff={setDiffPath}
          onFinalize={finalize}
          applying={applying}
        />
      )}
      {diffPath && (
        <PullDiffDialog plan={plan} initialPath={diffPath} buildDiff={buildDiff} onClose={() => setDiffPath(null)} />
      )}
    </>
  )
}
