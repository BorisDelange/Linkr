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
import { useAppStore } from '@/stores/app-store'
import { useSchemaPresetStore, buildSchemaPreset } from '@/stores/schema-preset-store'
import { localized, setLocalized } from '@/lib/localized'
import type { CustomSchemaPreset } from '@/types'

/** Edits a schema preset's name + description in the active language. */
export function SchemaPresetRenameDialog({ item, onOpenChange }: { item: CustomSchemaPreset; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const savePreset = useSchemaPresetStore((s) => s.savePreset)
  const [name, setName] = useState(() => localized(item.mapping.presetLabel, language))
  const [description, setDescription] = useState(() => (item.mapping.description ? localized(item.mapping.description, language) : ''))

  const handleSave = async () => {
    const label = name.trim()
    if (!label) return
    const mapping = {
      ...item.mapping,
      presetLabel: setLocalized(item.mapping.presetLabel, language, label),
      description: setLocalized(item.mapping.description ?? {}, language, description.trim()),
    }
    await savePreset(buildSchemaPreset(item.presetId, mapping, item, item.workspaceId))
    onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('common.edit')}</DialogTitle>
          <DialogDescription>{t('schemas.edit_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs">{t('schemas.field_name')}<RequiredMark /></Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSave() } }}
              className="h-8 text-sm"
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('schemas.field_description')}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-16 text-sm"
              placeholder={t('schemas.field_description_placeholder')}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleSave} disabled={!name.trim()}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
