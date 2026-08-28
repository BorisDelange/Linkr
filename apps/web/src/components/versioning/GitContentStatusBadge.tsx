import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isServerMode } from '@/lib/api-client'
import { type GitContentStatus, type GitScope } from '@/lib/api/git'
import { retryGitContentClone } from '@/lib/git-content-retry'
import { webRepoUrl } from '@/lib/git-web-url'
import { cn } from '@/lib/utils'
import type { GitLinkedEntity } from '@/lib/entity-io'

interface Props {
  workspaceId: string
  scope: GitScope
  type: GitLinkedEntity['type']
  id: string
  name: string
  gitRemote: { url: string; branch?: string } | null
  status: GitContentStatus['status'] | undefined
  onResolved: () => void
}

/** Badge shown on a git-linked entity's card when its content wasn't reconstituted
 *  (pending clone / failed). Offers a retry that re-clones from the linked repo. */
export function GitContentStatusBadge({ workspaceId, scope, type, id, name, gitRemote, status, onResolved }: Props) {
  const { t } = useTranslation()
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  if (!status) return null

  const retry = async () => {
    if (!gitRemote?.url) return
    setRetrying(true)
    setRetryError(null)
    try {
      const { ok, error } = await retryGitContentClone({
        scope, type, id, name, url: gitRemote.url, branch: gitRemote.branch || 'main', workspaceId,
      })
      if (ok) onResolved()
      else setRetryError(error || t('versioning.content_import_error_generic'))
    } finally {
      setRetrying(false)
    }
  }

  // Client-only has no git client, so there is nothing to retry — the one useful
  // action is to go read the repo the pointer names. The badge becomes that link.
  const repoUrl = !isServerMode() && gitRemote?.url ? webRepoUrl(gitRemote.url) : null

  const badge = (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 border-amber-400 text-amber-600 dark:text-amber-400',
        repoUrl && 'cursor-pointer hover:bg-amber-50 dark:hover:bg-amber-950/40',
      )}
    >
      <AlertTriangle size={12} />
      {t('versioning.content_not_imported')}
      {repoUrl && <ExternalLink size={11} className="opacity-70" />}
    </Badge>
  )

  return (
    <div className="flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          {repoUrl ? (
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              // The badge sits inside a clickable card; without this the card's
              // own onClick navigates instead of the link opening.
              onClick={(e) => e.stopPropagation()}
              className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {badge}
            </a>
          ) : (
            badge
          )}
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="whitespace-pre-line">
            {isServerMode()
              ? t('versioning.content_not_imported_hint')
              : t('versioning.content_not_imported_hint_clientonly')}
          </p>
          {repoUrl && (
            <p className="mt-2 border-t border-border/50 pt-2 font-medium">
              {t('versioning.content_open_repo')}
            </p>
          )}
          {retryError && (
            <div className="mt-2 border-t border-border/50 pt-2">
              <p className="mb-1 font-medium text-amber-500">{t('versioning.content_import_error_label')}</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed opacity-90">{retryError}</pre>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
      {isServerMode() && gitRemote?.url && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-2 text-xs text-amber-600 hover:bg-amber-50 hover:text-amber-700 dark:text-amber-400 dark:hover:bg-amber-950/40 dark:hover:text-amber-300"
          disabled={retrying}
          onClick={retry}
        >
          {retrying ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {t('versioning.content_retry_import')}
        </Button>
      )}
    </div>
  )
}
