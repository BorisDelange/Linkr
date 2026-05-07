import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { UserCog } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useAppStore } from '@/stores/app-store'

/**
 * Hook returning a guard for actions that must be attributed to a real user.
 *
 * Usage:
 *   const { requireIdentity, dialog } = useRequireIdentity()
 *   ...
 *   const handleClick = () => {
 *     if (!requireIdentity()) return  // dialog shown, action blocked
 *     // proceed with the action
 *   }
 *   return <>{dialog}{...rest}</>
 *
 * Returns true when the user has both a first and last name, false otherwise
 * (and opens a blocking dialog with a "Go to settings" shortcut).
 */
export function useRequireIdentity() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const user = useAppStore((s) => s.user)
  const [open, setOpen] = useState(false)

  const requireIdentity = useCallback((): boolean => {
    const ok = !!(user?.firstName?.trim() && user?.lastName?.trim())
    if (!ok) setOpen(true)
    return ok
  }, [user?.firstName, user?.lastName])

  const dialog = (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <UserCog size={18} />
            {t('concept_mapping.identity_required_title')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('concept_mapping.identity_required_desc')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => { setOpen(false); navigate('/profile') }}>
            {t('concept_mapping.identity_required_go_to_settings')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { requireIdentity, dialog }
}
