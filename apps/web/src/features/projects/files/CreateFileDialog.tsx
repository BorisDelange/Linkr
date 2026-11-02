import { useState, useMemo } from 'react'
import { isReservedTreeName, reservedTreeNameReason } from '@/lib/entity-tree'
import { useTranslation } from 'react-i18next'
import { useFileStore, buildScriptsFolderTree, getScriptsFolderId } from '@/stores/file-store'
import { FolderOpen } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { SearchableSelect, type SearchableSelectOption } from '@/components/ui/searchable-select'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAppStore } from '@/stores/app-store'
import { FILE_CATEGORIES, FILE_TYPES, type FileType } from './file-types'

interface CreateFileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentId: string | null
}

export function CreateFileDialog({
  open,
  onOpenChange,
  parentId,
}: CreateFileDialogProps) {
  const { t } = useTranslation()
  const { files, createFile, createFileWithContent, openFile } = useFileStore()
  const [name, setName] = useState('')
  const [fileType, setFileType] = useState('py')
  const [withExample, setWithExample] = useState(false)
  const favorites = useAppStore((s) => s.editorSettings.favoriteFileTypes)
  const updateEditorSettings = useAppStore((s) => s.updateEditorSettings)
  const [selectedParentId, setSelectedParentId] = useState<string>(
    parentId ?? '__root__'
  )

  const selectedType = FILE_TYPES.find((ft) => ft.id === fileType)!
  const typeOptions = useMemo(
    () => FILE_TYPES.map((ft) => ({ value: ft.id, label: `${t(ft.label)} (${ft.ext})`, group: ft.category })),
    [t],
  )
  const typeGroups = useMemo(
    () => FILE_CATEGORIES.map((c) => ({ value: c, label: t(`files.category_${c}`) })),
    [t],
  )
  const toggleFavorite = (id: string) =>
    updateEditorSettings({
      favoriteFileTypes: favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id],
    })
  const renderType = (option: SearchableSelectOption) => {
    const ft = FILE_TYPES.find((f) => f.id === option.value) as FileType
    const Icon = ft.icon
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Icon size={14} className={ft.iconColor} />
        <span className="truncate">
          {t(ft.label)} <span className="text-muted-foreground">({ft.ext})</span>
        </span>
      </span>
    )
  }
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

  const finalName = name.includes('.') ? name.trim() : `${name.trim()}${selectedType.ext}`
  const actualParentId = selectedParentId === '__root__' ? scriptsFolderId : selectedParentId
  const isReserved = finalName.length > 0 && isReservedTreeName(finalName, actualParentId)
  const isDuplicate = finalName.length > 0 && files.some(
    (f) => f.name === finalName && f.parentId === actualParentId
  )

  const handleSubmit = () => {
    if (!finalName || isDuplicate || isReserved) return
    const content = (withExample && selectedType.example) || selectedType.skeleton
    if (content) {
      // Written with the file, not after it: in server mode createFile re-reads
      // the folder from disk once created, which replaced any content set
      // meanwhile with the empty file it had written.
      createFileWithContent(finalName, actualParentId, content)
        .then((id) => { if (id) openFile(id) })
        .catch((err) => console.error('[create-file] Failed to persist file:', finalName, err))
    } else {
      createFile(finalName, actualParentId, selectedType.lang)
    }

    setName('')
    setFileType('py')
    setWithExample(false)
    onOpenChange(false)
  }

  const handleTypeChange = (val: string) => {
    setFileType(val)
    const ft = FILE_TYPES.find((f) => f.id === val)
    if (!ft) return
    if (name) {
      const baseName = name.replace(/\.[^.]+$/, '')
      setName(`${baseName}${ft.ext}`)
    } else if (ft.defaultName) {
      // The name the framework looks for (Shiny's app.R).
      setName(`${ft.defaultName}${ft.ext}`)
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={t('files.create_file')}
      description={t('files.create_file_description')}
      onConfirm={handleSubmit}
      confirmLabel={t('common.create')}
      confirmDisabled={!name.trim() || isDuplicate || isReserved}
    >
            <div className="space-y-2">
              <Label>{t('files.file_type')}</Label>
              <SearchableSelect
                value={fileType}
                options={typeOptions}
                groups={typeGroups}
                favorites={favorites}
                onToggleFavorite={toggleFavorite}
                onChange={handleTypeChange}
                placeholder={t('files.file_type')}
                renderOption={renderType}
                renderValue={renderType}
              />
            </div>
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
              <Label>{t('files.file_name')}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`${t('files.file_name_placeholder')}${selectedType.ext}`}
                autoFocus
              />
              {isDuplicate && (
                <p className="text-xs text-destructive">{t('files.name_already_exists')}</p>
              )}
              {isReserved && !isDuplicate && (
                <p className="text-xs text-destructive">{t(reservedTreeNameReason(finalName))}</p>
              )}
            </div>
            {selectedType.example && (
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="create-file-example">{t('files.with_example')}</Label>
                  <p className="text-xs text-muted-foreground">{t('files.with_example_hint')}</p>
                </div>
                <Switch id="create-file-example" checked={withExample} onCheckedChange={setWithExample} />
              </div>
            )}
    </DialogShell>
  )
}
