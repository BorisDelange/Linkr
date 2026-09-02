import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import { FieldError } from '@/components/ui/field-error'
import { DialogShell } from '@/components/ui/dialog-shell'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useAppStore } from '@/stores/app-store'
import { useSaveForm } from '@/hooks/use-save-form'
import { useUniqueName } from '@/hooks/use-unique-name'
import { localized, setLocalized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import type { Dashboard } from '@/types'

export function DashboardEditDialog({ item, onOpenChange }: { item: Dashboard; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const updateDashboard = useDashboardStore((s) => s.updateDashboard)
  const initialName = localized(item.name, language)
  const initialDescription = item.description ? localized(item.description, language) : ''
  const initialVersion = item.version ?? '0.1.0'
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const allDashboards = useDashboardStore((s) => s.dashboards)
  const siblings = useMemo(
    () => allDashboards.filter((d) => d.projectUid === item.projectUid),
    [allDashboards, item.projectUid],
  )
  const { nameError, canSubmit } = useUniqueName({
    name,
    siblings,
    exceptId: item.id,
    errorKey: 'dashboard.dashboard_name_exists',
  })

  const doSave = () => {
    updateDashboard(item.id, {
      name: setLocalized(item.name, language, name.trim()),
      description: setLocalized(item.description ?? {}, language, description.trim()),
      version: initialVersion,
    })
    onOpenChange(false)
  }

  const { canSaveNow, save } = useSaveForm({
    current: { name: name.trim(), description: description.trim() },
    baseline: { name: initialName, description: initialDescription },
    onSave: doSave,
    canSave: canSubmit,
  })

  return (
    <DialogShell
      open
      onOpenChange={onOpenChange}
      title={t('dashboard.edit_title')}
      description={t('dashboard.edit_description')}
      onConfirm={save}
      confirmLabel={t('common.save')}
      confirmDisabled={!canSaveNow}
      dirtyTracked
      contentClassName="space-y-3"
    >
      <div className="space-y-1">
        <Label className="text-xs">{t('dashboard.field_name')}<RequiredMark /></Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn('h-8 text-sm', nameError && 'border-destructive')}
          autoFocus
        />
        <FieldError message={nameError} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t('dashboard.field_description')}</Label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="text-sm"
          placeholder={t('dashboard.field_description_placeholder')}
        />
      </div>
    </DialogShell>
  )
}
