import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileStore } from '@/stores/file-store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

interface RenameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  nodeId: string
  currentName: string
  /** Optional override for rename — used by dataset bridge nodes. */
  onRename?: (newName: string) => void
}

export function RenameDialog({
  open,
  onOpenChange,
  nodeId,
  currentName,
  onRename,
}: RenameDialogProps) {
  const { t } = useTranslation()
  const { renameNode } = useFileStore()
  const [name, setName] = useState(currentName)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || name.trim() === currentName) {
      onOpenChange(false)
      return
    }
    if (onRename) {
      onRename(name.trim())
    } else {
      renameNode(nodeId, name.trim())
    }
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setName(currentName)
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('files.rename')}</DialogTitle>
            <DialogDescription className="sr-only">
              {t('files.rename')}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-2">
            <Label>{t('files.file_name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onFocus={(e) => {
                const dotIdx = name.lastIndexOf('.')
                if (dotIdx > 0) {
                  e.target.setSelectionRange(0, dotIdx)
                } else {
                  e.target.select()
                }
              }}
            />
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
