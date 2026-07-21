import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileCode, FileText, FolderOpen } from 'lucide-react'
import {
  Dialog,
  DialogContent,
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
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import type { SqlScriptFile } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  collectionId: string
  /** Folder to create the item in. `null` = root. Pre-selected in the picker. */
  parentId: string | null
  /** When true the dialog creates a folder instead of a file. */
  folderMode: boolean
}

/** File types offered in a SQL script collection. The editor renders `.md`
 * as markdown and everything else as SQL. */
const fileTypes = [
  { id: 'sql', label: 'files.type_sql', ext: '.sql', icon: FileCode, iconColor: 'text-orange-400' },
  { id: 'md', label: 'files.type_markdown', ext: '.md', icon: FileText, iconColor: 'text-muted-foreground' },
]

const ROOT_VALUE = '__root__'

/** Flatten the collection's folders into a depth-labelled list for the picker. */
function buildFolderOptions(files: SqlScriptFile[]) {
  const out: { id: string; name: string; depth: number }[] = []
  const walk = (parentId: string | null, depth: number) => {
    files
      .filter((f) => f.type === 'folder' && f.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((folder) => {
        out.push({ id: folder.id, name: folder.name, depth })
        walk(folder.id, depth + 1)
      })
  }
  walk(null, 0)
  return out
}

export function CreateSqlScriptFileDialog({
  open,
  onOpenChange,
  collectionId,
  parentId,
  folderMode,
}: Props) {
  const { t } = useTranslation()
  const { files, createFile, selectFile } = useSqlScriptsStore()

  const [name, setName] = useState('')
  const [fileType, setFileType] = useState('sql')
  const [selectedParentId, setSelectedParentId] = useState<string>(parentId ?? ROOT_VALUE)

  // Reset on the open transition so the dialog reflects the folder it was
  // launched from (adjust-state-during-render — no effect / cascading render).
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setName('')
      setFileType('sql')
      setSelectedParentId(parentId ?? ROOT_VALUE)
    }
  }

  const folderOptions = useMemo(() => buildFolderOptions(files), [files])
  const selectedType = fileTypes.find((ft) => ft.id === fileType)!
  const actualParentId = selectedParentId === ROOT_VALUE ? null : selectedParentId

  const finalName = (() => {
    const n = name.trim()
    if (!n) return ''
    if (folderMode) return n
    return n.includes('.') ? n : `${n}${selectedType.ext}`
  })()

  const isDuplicate =
    !!finalName &&
    files.some(
      (f) => f.parentId === actualParentId && f.name.toLowerCase() === finalName.toLowerCase(),
    )

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!finalName || isDuplicate) return
    const now = new Date().toISOString()
    const node: SqlScriptFile = folderMode
      ? {
          id: crypto.randomUUID(), collectionId, name: finalName, type: 'folder',
          parentId: actualParentId, order: files.length, createdAt: now,
        }
      : {
          id: crypto.randomUUID(), collectionId, name: finalName, type: 'file',
          parentId: actualParentId, content: '', order: files.length, createdAt: now,
        }
    await createFile(node)
    if (!folderMode) selectFile(node.id)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={(e) => {
          // Radix would focus the first tabbable element (the type Select);
          // send the caret to the name field (the only <input> here) instead.
          e.preventDefault()
          e.currentTarget.querySelector('input')?.focus()
        }}
      >
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{folderMode ? t('files.new_folder') : t('sql_scripts.new_file')}</DialogTitle>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            {!folderMode && (
              <div className="space-y-2">
                <Label>{t('files.file_type')}</Label>
                <Select value={fileType} onValueChange={setFileType}>
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
                              <span className="text-muted-foreground">({ft.ext})</span>
                            </span>
                          </div>
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>{t('files.parent_folder')}</Label>
              <Select value={selectedParentId} onValueChange={setSelectedParentId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOT_VALUE}>
                    <div className="flex items-center gap-2">
                      <FolderOpen size={14} className="text-muted-foreground" />
                      <span>{t('files.root_folder')}</span>
                    </div>
                  </SelectItem>
                  {folderOptions.map((folder) => (
                    <SelectItem key={folder.id} value={folder.id}>
                      <div className="flex items-center gap-2" style={{ paddingLeft: folder.depth * 12 }}>
                        <FolderOpen size={14} className="text-muted-foreground" />
                        <span>{folder.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{folderMode ? t('common.name') : t('sql_scripts.file_name')}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={folderMode ? 'measurement' : `urine_output${selectedType.ext}`}
              />
              {isDuplicate && (
                <p className="text-xs text-destructive">
                  {t('sql_scripts.name_exists', { name: finalName })}
                </p>
              )}
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
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
