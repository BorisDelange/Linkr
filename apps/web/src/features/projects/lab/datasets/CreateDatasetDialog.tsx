import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import { useDatasetStore } from '@/stores/dataset-store'

interface CreateDatasetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentId: string | null
}

export function CreateDatasetDialog({ open, onOpenChange, parentId }: CreateDatasetDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { createFile } = useDatasetStore()

  const handleCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed || creating) return
    const fileName = trimmed.endsWith('.csv') ? trimmed : `${trimmed}.csv`
    setCreating(true)
    setError(null)
    try {
      await createFile(fileName, parentId)
      setName('')
      onOpenChange(false)
    } catch (e) {
      setError(t('datasets.create_failed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t('datasets.new_dataset')}</DialogTitle>
          <DialogDescription>{t('datasets.new_dataset_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="dataset-name">{t('datasets.name')}<RequiredMark /></Label>
            <Input
              id="dataset-name"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null) }}
              placeholder="my_dataset.csv"
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void handleCreate() }
              }}
              autoFocus
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!name.trim() || creating}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
