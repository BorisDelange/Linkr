import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, Lock } from 'lucide-react'
import { PasswordInput } from '@/components/ui/password-input'
import { Label } from '@/components/ui/label'
import { DialogShell } from '@/components/ui/dialog-shell'
import { apiFetch } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'

const isServerMode = !!import.meta.env.VITE_API_URL
// Mirrors the server's policy (core/security.py PASSWORD_MIN_LENGTH), which is
// what actually enforces it.
const MIN_LENGTH = 12

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

  const canSubmit = current.length > 0 && next.length >= MIN_LENGTH && next === confirm && !submitting

  const handleSubmit = async () => {
    setError(null)
    if (next !== confirm) { setError(t('profile.password_mismatch')); return }
    if (next.length < MIN_LENGTH) { setError(t('profile.password_too_short', { count: MIN_LENGTH })); return }
    setSubmitting(true)
    try {
      const res = await apiFetch('/api/v1/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })
      if (!res.ok) {
        const msg = res.status === 403
          ? t('profile.password_current_wrong')
          : res.status === 422
            ? t('profile.password_policy_rejected', { count: MIN_LENGTH })
            : t('profile.password_change_error')
        setError(msg)
        setSubmitting(false)
        return
      }
      // The change ends every session issued before it, this one included.
      const data = await res.json()
      useAuthStore.getState().setTokens(data.access_token, data.refresh_token, data.user)
      handleOpenChange(false)
    } catch {
      setError(t('profile.password_change_error'))
      setSubmitting(false)
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={handleOpenChange}
      title={
        <span className="flex items-center gap-2">
          <Lock size={16} />
          {t('profile.change_password')}
        </span>
      }
      description={t('profile.change_password_description')}
      onConfirm={handleSubmit}
      confirmLabel={t('common.save')}
      confirmDisabled={!canSubmit}
      hideFooter={!isServerMode}
      contentClassName={isServerMode ? undefined : 'space-y-0'}
    >
      {isServerMode ? (
        <>
          <div className="space-y-2">
            <Label>{t('profile.current_password')}</Label>
            <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </div>
          <div className="space-y-2">
            <Label>{t('profile.new_password')}</Label>
            <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </div>
          <div className="space-y-2">
            <Label>{t('profile.confirm_password')}</Label>
            <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
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
    </DialogShell>
  )
}
