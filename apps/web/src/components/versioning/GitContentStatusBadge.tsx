import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isServerMode } from '@/lib/api-client'
import { type GitContentStatus, type GitScope } from '@/lib/api/git'
import { retryGitContentClone } from '@/lib/git-content-retry'
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
  if (!status) return null

  const retry = async () => {
    if (!gitRemote?.url) return
    setRetrying(true)
    try {
      const ok = await retryGitContentClone({
        scope, type, id, name, url: gitRemote.url, branch: gitRemote.branch || 'main', workspaceId,
      })
      if (ok) onResolved()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1 border-amber-400 text-amber-600 dark:text-amber-400">
            <AlertTriangle size={12} />
            {t('versioning.content_not_imported')}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs whitespace-pre-line">
          {isServerMode()
            ? t('versioning.content_not_imported_hint')
            : t('versioning.content_not_imported_hint_clientonly')}
        </TooltipContent>
      </Tooltip>
      {isServerMode() && gitRemote?.url && (
        <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs" disabled={retrying} onClick={retry}>
          {retrying ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {t('versioning.content_retry_import')}
        </Button>
      )}
    </div>
  )
}
