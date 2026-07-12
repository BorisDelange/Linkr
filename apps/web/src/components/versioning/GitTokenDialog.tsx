import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { gitVerifyRemote } from '@/lib/api/git'
import { toGitError } from '@/lib/git-error-message'
import type { GitErrorCode } from '@/lib/api/git'
import { GitErrorNotice } from './GitErrorNotice'

interface GitTokenDialogProps {
  url: string
  onSave: (token: string) => Promise<void>
  onClose: () => void
}

/** Update the access token of a linked repo: verify the new token against the
 *  remote before saving, so an invalid token is caught here, not on next sync. */
export function GitTokenDialog({ url, onSave, onClose }: GitTokenDialogProps) {
  const { t } = useTranslation()
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ code: GitErrorCode; raw: string } | null>(null)

  const handleSave = async () => {
    if (!token.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      await gitVerifyRemote(url, token.trim())
      await onSave(token.trim())
      onClose()
    } catch (err) {
      setError(toGitError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('versioning.token_dialog_title')}</DialogTitle>
          <DialogDescription>{t('versioning.token_dialog_desc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs">{t('versioning.remote_token')}</Label>
          <Input
            type="password"
            value={token}
            autoFocus
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('versioning.remote_token_placeholder')}
            className="h-9 text-sm"
          />
        </div>
        {error && <GitErrorNotice code={error.code} raw={error.raw} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!token.trim() || saving} className="gap-1.5">
            {saving && <Loader2 size={14} className="animate-spin" />}
            {t('versioning.token_dialog_save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
