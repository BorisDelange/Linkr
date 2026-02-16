import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileStore, buildFolderTree } from '@/stores/file-store'
import {
  FileText,
  FileCode,
  Database,
  Terminal,
  BookOpen,
  Table2,
  FileJson,
  FolderOpen,
} from 'lucide-react'
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

interface CreateFileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentId: string | null
}

const fileTypes = [
  {
    id: 'py',
    label: 'files.type_python',
    ext: '.py',
    lang: 'python',
    icon: FileCode,
    iconColor: 'text-blue-500',
  },
  {
    id: 'r',
    label: 'files.type_r',
    ext: '.R',
    lang: 'r',
    icon: FileCode,
    iconColor: 'text-sky-500',
  },
  {
    id: 'sql',
    label: 'files.type_sql',
    ext: '.sql',
    lang: 'sql',
    icon: Database,
    iconColor: 'text-amber-500',
  },
  {
    id: 'ipynb',
    label: 'files.type_jupyter',
    ext: '.ipynb',
    lang: 'json',
    icon: Table2,
    iconColor: 'text-orange-500',
  },
  {
    id: 'rmd',
    label: 'files.type_rmd',
    ext: '.Rmd',
    lang: 'markdown',
    icon: BookOpen,
    iconColor: 'text-violet-500',
  },
  {
    id: 'qmd',
    label: 'files.type_quarto',
    ext: '.qmd',
    lang: 'markdown',
    icon: FileJson,
    iconColor: 'text-teal-500',
  },
  {
    id: 'sh',
    label: 'files.type_shell',
    ext: '.sh',
    lang: 'shell',
    icon: Terminal,
    iconColor: 'text-green-500',
  },
  {
    id: 'txt',
    label: 'files.type_text',
    ext: '.txt',
    lang: 'plaintext',
    icon: FileText,
    iconColor: 'text-muted-foreground',
  },
]

export function CreateFileDialog({
  open,
  onOpenChange,
  parentId,
}: CreateFileDialogProps) {
  const { t } = useTranslation()
  const { files, createFile } = useFileStore()
  const [name, setName] = useState('')
  const [fileType, setFileType] = useState('py')
  const [selectedParentId, setSelectedParentId] = useState<string>(
    parentId ?? '__root__'
  )

  const selectedType = fileTypes.find((ft) => ft.id === fileType)!
  const folderTree = useMemo(() => buildFolderTree(files), [files])

  const finalName = name.includes('.') ? name.trim() : `${name.trim()}${selectedType.ext}`
  const actualParentId = selectedParentId === '__root__' ? null : selectedParentId
  const isDuplicate = finalName.length > 0 && files.some(
    (f) => f.name === finalName && f.parentId === actualParentId
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!finalName || isDuplicate) return
    createFile(finalName, actualParentId, selectedType.lang)
    setName('')
    setFileType('py')
    onOpenChange(false)
  }

  const handleTypeChange = (val: string) => {
    setFileType(val)
    const ft = fileTypes.find((f) => f.id === val)
    if (ft && name) {
      const baseName = name.replace(/\.[^.]+$/, '')
      setName(`${baseName}${ft.ext}`)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('files.create_file')}</DialogTitle>
            <DialogDescription>
              {t('files.create_file_description')}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label>{t('files.file_type')}</Label>
              <Select value={fileType} onValueChange={handleTypeChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fileTypes.map((ft) => {
                    const Icon = ft.icon
                    return (
                      <SelectItem key={ft.id} value={ft.id}>
                        <div className="flex items-center gap-2">
                          <Icon size={14} className={ft.iconColor} />
                          <span>
                            {t(ft.label)}{' '}
                            <span className="text-muted-foreground">
                              ({ft.ext})
                            </span>
                          </span>
                        </div>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
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
            <Button type="submit" disabled={!name.trim() || isDuplicate}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
