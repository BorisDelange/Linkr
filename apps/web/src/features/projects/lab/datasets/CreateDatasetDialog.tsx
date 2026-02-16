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
import { useDatasetStore } from '@/stores/dataset-store'

interface CreateDatasetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentId: string | null
}

export function CreateDatasetDialog({ open, onOpenChange, parentId }: CreateDatasetDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const { createFile } = useDatasetStore()

  const handleCreate = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const fileName = trimmed.endsWith('.csv') ? trimmed : `${trimmed}.csv`
    createFile(fileName, parentId)
    setName('')
    onOpenChange(false)
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
            <Label htmlFor="dataset-name">{t('datasets.name')}</Label>
            <Input
              id="dataset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my_dataset.csv"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
              }}
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={!name.trim()}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
