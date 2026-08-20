import { useState, useMemo } from 'react'
import { isReservedTreeName, reservedTreeNameReason } from '@/lib/entity-tree'
import { useTranslation } from 'react-i18next'
import { useFileStore, buildScriptsFolderTree, getScriptsFolderId, RESERVED_ROOT_FOLDERS } from '@/stores/file-store'
import { FolderOpen } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

  const folderTree = useMemo(() => buildScriptsFolderTree(files), [files])
  const scriptsFolderId = useMemo(() => getScriptsFolderId(files), [files])

  // On the open transition, point the parent picker at the folder the dialog was
  // launched from (adjust-state-during-render — no effect). The scripts root maps
  // to the "__root__" sentinel (it isn't listed among the scripts subfolders).
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setSelectedParentId(!parentId || parentId === scriptsFolderId ? '__root__' : parentId)
    }
  }

  const trimmedName = name.trim()
  const actualParentId = selectedParentId === '__root__' ? scriptsFolderId : selectedParentId
  const isDuplicate = trimmedName.length > 0 && files.some(
    (f) => f.name === trimmedName && f.parentId === actualParentId
  )
  const isReserved =
    trimmedName.length > 0 &&
    ((!actualParentId && RESERVED_ROOT_FOLDERS.has(trimmedName)) ||
      isReservedTreeName(trimmedName, actualParentId))

  const handleSubmit = () => {
    if (!trimmedName || isDuplicate || isReserved) return
    createFolder(trimmedName, actualParentId)
    setName('')
    onOpenChange(false)
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t('files.create_folder')}
      description={t('files.create_folder_description')}
      onConfirm={handleSubmit}
      confirmLabel={t('common.create')}
      confirmDisabled={!trimmedName || isDuplicate || isReserved}
    >
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
                      <span>scripts</span>
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
              {isReserved && (
                <p className="text-xs text-destructive">{t(reservedTreeNameReason(trimmedName))}</p>
              )}
            </div>
    </DialogShell>
  )
}
