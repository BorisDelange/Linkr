import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileStore, buildFolderTree } from '@/stores/file-store'
import { FolderOpen } from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface CreateFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentId: string | null
}

export function CreateFolderDialog({
  open,
  onOpenChange,
  parentId,
}: CreateFolderDialogProps) {
  const { t } = useTranslation()
  const { files, createFolder } = useFileStore()
  const [name, setName] = useState('')
  const [selectedParentId, setSelectedParentId] = useState<string>(
    parentId ?? '__root__'
  )

  const folderTree = useMemo(() => buildFolderTree(files), [files])

  const trimmedName = name.trim()
  const actualParentId = selectedParentId === '__root__' ? null : selectedParentId
  const isDuplicate = trimmedName.length > 0 && files.some(
    (f) => f.name === trimmedName && f.parentId === actualParentId
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!trimmedName || isDuplicate) return
    createFolder(trimmedName, actualParentId)
    setName('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('files.create_folder')}</DialogTitle>
            <DialogDescription>
              {t('files.create_folder_description')}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label>{t('files.parent_folder')}</Label>
              <Select
                value={selectedParentId}
                onValueChange={setSelectedParentId}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__root__">
                    <div className="flex items-center gap-2">
                      <FolderOpen size={14} className="text-muted-foreground" />
                      <span>{t('files.root')}</span>
                    </div>
                  </SelectItem>
                  {folderTree.map((folder) => (
                    <SelectItem key={folder.id} value={folder.id}>
                      <div
                        className="flex items-center gap-2"
                        style={{ paddingLeft: folder.depth * 12 }}
                      >
                        <FolderOpen
                          size={14}
                          className="text-muted-foreground"
                        />
                        <span>{folder.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('files.folder_name')}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('files.folder_name_placeholder')}
                autoFocus
              />
              {isDuplicate && (
                <p className="text-xs text-destructive">{t('files.name_already_exists')}</p>
              )}
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!trimmedName || isDuplicate}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
