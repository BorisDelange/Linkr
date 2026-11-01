import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Workspace } from '@/types'

/** Workspace Settings → Versioning: how changes reach the workspace's repositories. */
export function VersioningSettingsTab({ workspace, canWrite }: { workspace: Workspace; canWrite: boolean }) {
  const { t } = useTranslation()
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace)

  return (
    <div className="mx-auto max-w-2xl py-2">
      <Card>
        <CardContent className="flex items-start gap-3">
          <Switch
            id="ws-review-mode"
            checked={workspace.gitPushPolicy === 'review'}
            disabled={!canWrite}
            onCheckedChange={(on) => void updateWorkspace(workspace.id, { gitPushPolicy: on ? 'review' : 'direct' })}
          />
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="ws-review-mode">{t('versioning.review_mode')}</Label>
            <p className="text-xs text-muted-foreground">{t('versioning.review_mode_hint')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
