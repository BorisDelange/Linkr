import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { localized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import type { ConceptList } from '@/types'

interface ConceptListEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The list being edited, or null to create a new one. */
  list: ConceptList | null
  /** Receives the plain strings; the caller merges them into the active language. */
  onSave: (values: { name: string; description: string }) => void
}

/**
 * Create or rename a concept list.
 *
 * One field per property, written into the currently selected app language —
 * the same convention as the project dialog. Values in other languages are
 * preserved by the caller's merge, so switching language and editing never
 * wipes a translation.
 */
export function ConceptListEditDialog({
  open,
  onOpenChange,
  list,
  onSave,
}: ConceptListEditDialogProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // Re-seed whenever the dialog opens so it never shows the previous list.
  useEffect(() => {
    if (!open) return
    setName(list ? localized(list.name, language) : '')
    setDescription(list ? localized(list.description, language) : '')
  }, [open, list, language])

  const canSave = name.trim().length > 0

  const handleSave = () => {
    if (!canSave) return
    onSave({ name: name.trim(), description: description.trim() })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {list ? t('concepts.list_edit_title') : t('concepts.list_create_title')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('concepts.column_name')}</Label>
            <Input
              autoFocus
              className="h-8 text-xs"
              placeholder={t('concepts.list_name_placeholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleSave() }
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('common.description')}</Label>
            <Textarea
              className="min-h-[72px] text-xs"
              placeholder={t('concepts.list_description_placeholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
