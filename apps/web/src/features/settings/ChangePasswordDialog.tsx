import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const isServerMode = !!import.meta.env.VITE_API_URL

interface ChangePasswordDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const { t } = useTranslation()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const reset = () => {
    setCurrent(''); setNext(''); setConfirm(''); setError(null); setSubmitting(false)
  }

  const handleOpenChange = (o: boolean) => {
    if (!o) reset()
    onOpenChange(o)
  }

  const canSubmit = current.length > 0 && next.length >= 8 && next === confirm && !submitting

  const handleSubmit = async () => {
    setError(null)
    if (next !== confirm) { setError(t('profile.password_mismatch')); return }
    if (next.length < 8) { setError(t('profile.password_too_short')); return }
    setSubmitting(true)
    try {
      const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000'
      const res = await fetch(`${baseUrl}/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })
      if (!res.ok) {
        const msg = res.status === 401 || res.status === 403
          ? t('profile.password_current_wrong')
          : t('profile.password_change_error')
        setError(msg)
        setSubmitting(false)
        return
      }
      handleOpenChange(false)
    } catch {
      setError(t('profile.password_change_error'))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock size={16} />
            {t('profile.change_password')}
          </DialogTitle>
          <DialogDescription>{t('profile.change_password_description')}</DialogDescription>
        </DialogHeader>

        {isServerMode ? (
          <>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>{t('profile.current_password')}</Label>
                <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
              </div>
              <div className="space-y-2">
                <Label>{t('profile.new_password')}</Label>
                <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
              </div>
              <div className="space-y-2">
                <Label>{t('profile.confirm_password')}</Label>
                <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>{t('common.cancel')}</Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>{t('common.save')}</Button>
            </DialogFooter>
          </>
        ) : (
          <div className="flex flex-col items-center py-6">
            <Lock size={36} className="text-muted-foreground/50" />
            <p className="mt-3 text-sm font-medium text-foreground">
              {t('profile.change_password_requires_backend')}
            </p>
            <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950 max-w-md">
              <Info size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {t('profile.change_password_requires_backend_description')}
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
