import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, GitPullRequest } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { SectionLabel } from '@/components/ui/section-label'
import { gitProposals, type GitProposal, type GitScope } from '@/lib/api/git'
import { cn } from '@/lib/utils'

const STATE_CLASS: Record<GitProposal['state'], string> = {
  open: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  merged: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  closed: 'bg-muted text-muted-foreground',
}

/**
 * The merge / pull requests opened from Linkr for one entity, with their state as
 * the forge last reported it. Review and merging happen on the forge; once merged,
 * the next pull brings the change back and nothing is left to push.
 */
export function GitProposals({ scope, id, refreshKey }: { scope: GitScope; id: string; refreshKey: number }) {
  const { t } = useTranslation()
  const [proposals, setProposals] = useState<GitProposal[]>([])

  useEffect(() => {
    let cancelled = false
    gitProposals(scope, id)
      .then((rows) => { if (!cancelled) setProposals(rows) })
      .catch(() => { if (!cancelled) setProposals([]) })
    return () => { cancelled = true }
  }, [scope, id, refreshKey])

  if (proposals.length === 0) return null
  return (
    <div className="shrink-0 rounded-lg border bg-card">
      <SectionLabel className="border-b px-3 py-1.5">{t('versioning.proposals_title')}</SectionLabel>
      <ul className="max-h-36 divide-y overflow-y-auto">
        {proposals.map((p) => (
          <li key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <GitPullRequest size={13} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={p.title}>{p.title}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{p.branch} → {p.targetBranch}</span>
            <Badge className={cn('shrink-0', STATE_CLASS[p.state])}>{t(`versioning.proposal_state_${p.state}`)}</Badge>
            <a
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              {p.forge === 'github' ? `#${p.number}` : `!${p.number}`}
              <ExternalLink size={11} />
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
