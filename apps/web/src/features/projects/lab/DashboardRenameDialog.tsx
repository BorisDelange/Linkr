import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import type { Dashboard } from '@/types'

export function DashboardRenameDialog({ item, onOpenChange }: { item: Dashboard; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const updateDashboard = useDashboardStore((s) => s.updateDashboard)
  const [name, setName] = useState(() => localized(item.name, language))

  const handleSave = () => {
    if (!name.trim()) return
    updateDashboard(item.id, { name: setLocalized(item.name, language, name.trim()) })
    onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dashboard.rename_title')}</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 text-sm"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSave() } }}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!name.trim() || name.trim() === localized(item.name, language)}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
