import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useAppStore } from '@/stores/app-store'
import { useSaveForm } from '@/hooks/use-save-form'
import { localized, setLocalized } from '@/lib/localized'
import type { Dashboard } from '@/types'

export function DashboardEditDialog({ item, onOpenChange }: { item: Dashboard; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const updateDashboard = useDashboardStore((s) => s.updateDashboard)
  const initialName = localized(item.name, language)
  const initialDescription = item.description ? localized(item.description, language) : ''
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)

  const doSave = () => {
    updateDashboard(item.id, {
      name: setLocalized(item.name, language, name.trim()),
      description: setLocalized(item.description ?? {}, language, description.trim()),
    })
    onOpenChange(false)
  }

  const { canSaveNow, save } = useSaveForm({
    current: { name: name.trim(), description: description.trim() },
    baseline: { name: initialName, description: initialDescription },
    onSave: doSave,
    canSave: name.trim().length > 0,
  })

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dashboard.edit_title')}</DialogTitle>
          <DialogDescription>{t('dashboard.edit_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs">{t('dashboard.field_name')}<RequiredMark /></Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 text-sm"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } }}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('dashboard.field_description')}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-16 text-sm"
              placeholder={t('dashboard.field_description_placeholder')}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={save} disabled={!canSaveNow}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
