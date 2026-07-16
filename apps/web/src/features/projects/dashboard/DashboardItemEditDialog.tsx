import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAppStore } from '@/stores/app-store'
import { useSaveForm } from '@/hooks/use-save-form'
import { localized, setLocalized } from '@/lib/localized'
import type { LocalizedString } from '@/types'

/**
 * Edit a dashboard tab's or widget's name + description. Only the active UI language is edited
 * (single visible field per property), merged back into the {en,fr} object — the same convention
 * as the dashboard/project edit dialogs. The name stays unique among siblings (case-insensitive).
 */
export function DashboardItemEditDialog({
  title,
  name,
  description,
  siblingNames,
  onSave,
  onOpenChange,
}: {
  /** Dialog heading — e.g. "Edit tab" / "Edit widget". */
  title: string
  name: LocalizedString
  description: LocalizedString | undefined
  /** Names of the other items at this level (lowercased, in the active language) — for dup detection. */
  siblingNames: Set<string>
  onSave: (changes: { name: LocalizedString; description: LocalizedString }) => void
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const initialName = localized(name, language)
  const initialDescription = description ? localized(description, language) : ''
  const [nameValue, setNameValue] = useState(initialName)
  const [descriptionValue, setDescriptionValue] = useState(initialDescription)

  const trimmedName = nameValue.trim()
  const isDuplicate = trimmedName.length > 0 && trimmedName.toLowerCase() !== initialName.toLowerCase() && siblingNames.has(trimmedName.toLowerCase())

  const doSave = () => {
    onSave({
      name: setLocalized(name, language, trimmedName),
      description: setLocalized(description ?? {}, language, descriptionValue.trim()),
    })
    onOpenChange(false)
  }

  const { canSaveNow, save } = useSaveForm({
    current: { name: trimmedName, description: descriptionValue.trim() },
    baseline: { name: initialName, description: initialDescription },
    onSave: doSave,
    canSave: trimmedName.length > 0 && !isDuplicate,
  })

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('dashboard.item_edit_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs">{t('dashboard.item_field_name')}<RequiredMark /></Label>
            <Input
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              className={`h-8 text-sm ${isDuplicate ? 'border-destructive focus-visible:ring-destructive/40' : ''}`}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } }}
              autoFocus
            />
            {isDuplicate && (
              <p className="text-[11px] text-destructive">{t('dashboard.item_name_exists')}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('dashboard.item_field_description')}</Label>
            <Textarea
              value={descriptionValue}
              onChange={(e) => setDescriptionValue(e.target.value)}
              className="min-h-24 text-sm"
              placeholder={t('dashboard.item_field_description_placeholder')}
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
