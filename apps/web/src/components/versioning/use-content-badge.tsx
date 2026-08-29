import type React from 'react'
import { isServerMode } from '@/lib/api-client'
import { type GitScope } from '@/lib/api/git'
import { cardRepoUrl } from '@/lib/git-web-url'
import type { GitLinkedEntity } from '@/lib/entity-io'
import { GitContentStatusBadge } from './GitContentStatusBadge'
import { useGitContentStatuses } from './use-git-content-statuses'

/**
 * The two things every card grid needs about a git-linked entity whose content
 * was not reconstituted: the badge to show, and where the card should go instead
 * of navigating into an empty entity.
 *
 * Both were rebuilt at each call site behind the same
 * `workspaceId && remote?.url && status` guard, four times over — the repo-url
 * half had already been extracted to `cardRepoUrl`, the badge half had not.
 * Keeping them together also keeps them consistent: a card must not link to the
 * repo while showing no badge, or badge without the link.
 */
export function useContentBadge(
  scope: GitScope | undefined,
  workspaceId: string | null | undefined,
): {
  /** The badge, or null when this entity's content is fine (or not git-linked). */
  badgeFor: (args: {
    type: GitLinkedEntity['type']
    id: string
    name: string
    gitRemote: { url: string; branch?: string } | null | undefined
  }) => React.ReactNode
  /** The repo page to open instead of navigating, or null to navigate normally. */
  repoUrlFor: (id: string, url: string | undefined | null) => string | null
  /** Re-read the statuses, e.g. after a retry resolved one. */
  refetch: () => Promise<void>
} {
  const { statuses, refetch } = useGitContentStatuses(workspaceId)
  const statusOf = (id: string) => (scope ? statuses.get(`${scope}:${id}`) : undefined)

  return {
    badgeFor: ({ type, id, name, gitRemote }) => {
      const status = statusOf(id)
      if (!workspaceId || !scope || !gitRemote?.url || !status) return null
      return (
        <GitContentStatusBadge
          workspaceId={workspaceId}
          scope={scope}
          type={type}
          id={id}
          name={name}
          gitRemote={gitRemote}
          status={status}
          onResolved={() => { void refetch() }}
        />
      )
    },
    repoUrlFor: (id, url) => cardRepoUrl({ serverMode: isServerMode(), status: statusOf(id), url }),
    refetch,
  }
}
