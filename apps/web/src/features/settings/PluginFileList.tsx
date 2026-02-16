import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  File,
  FileCode,
  FileJson,
  FileText,
  FilePlus,
  PanelLeft,
  Trash2,
  Pencil,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'

function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (filename.endsWith('.py.template') || ext === 'py')
    return <FileCode size={14} className="shrink-0 text-yellow-500" />
  if (filename.endsWith('.R.template') || ext === 'r' || ext === 'rmd')
    return <FileCode size={14} className="shrink-0 text-blue-500" />
  if (ext === 'json')
    return <FileJson size={14} className="shrink-0 text-green-400" />
  if (ext === 'md')
    return <FileText size={14} className="shrink-0 text-muted-foreground" />
  if (ext === 'js' || ext === 'jsx' || ext === 'ts' || ext === 'tsx')
    return <FileCode size={14} className="shrink-0 text-amber-500" />
  if (ext === 'sql')
    return <FileCode size={14} className="shrink-0 text-orange-400" />
  return <File size={14} className="shrink-0 text-muted-foreground" />
}

interface PluginFileListProps {
  onCollapse?: () => void
}

export function PluginFileList({ onCollapse }: PluginFileListProps) {
  const { t } = useTranslation()
  const {
    files,
    activeFile,
    isBuiltIn,
    openFile,
    createFile,
    deleteFile,
    renameFile,
  } = usePluginEditorStore()

  const [creating, setCreating] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [renamingFile, setRenamingFile] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const filenames = Object.keys(files).sort((a, b) => {
    if (a === 'plugin.json') return -1
    if (b === 'plugin.json') return 1
    return a.localeCompare(b)
  })

  const handleCreate = () => {
    const name = newFileName.trim()
    if (name && !files[name]) {
      createFile(name)
      setNewFileName('')
      setCreating(false)
    }
  }

  const handleRename = (oldName: string) => {
    const name = renameValue.trim()
    if (name && name !== oldName && !files[name]) {
      renameFile(oldName, name)
    }
    setRenamingFile(null)
    setRenameValue('')
  }

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex h-full flex-col border-r">
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          {!isBuiltIn && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => { setCreating(true); setNewFileName('') }}
                >
                  <FilePlus size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('plugins.new_file_tooltip')}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {onCollapse && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={onCollapse}>
                <PanelLeft size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('plugins.collapse_files')}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex-1 overflow-auto py-1">
        {filenames.map((filename) => (
          <ContextMenu key={filename}>
            <ContextMenuTrigger>
              {renamingFile === filename ? (
                <div className="px-2 py-0.5">
                  <Input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(filename)
                      if (e.key === 'Escape') setRenamingFile(null)
                    }}
                    onBlur={() => handleRename(filename)}
                    autoFocus
                    className="h-6 text-xs"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => openFile(filename)}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-sm px-3 py-1 text-xs transition-colors',
                    activeFile === filename
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground/80 hover:bg-accent/50',
                  )}
                >
                  {getFileIcon(filename)}
                  <span className="truncate">{filename}</span>
                </button>
              )}
            </ContextMenuTrigger>
            {!isBuiltIn && filename !== 'plugin.json' && (
              <ContextMenuContent>
                <ContextMenuItem onClick={() => { setRenamingFile(filename); setRenameValue(filename) }}>
                  <Pencil size={12} className="mr-2" />
                  {t('plugins.rename_file')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => deleteFile(filename)} className="text-destructive">
                  <Trash2 size={12} className="mr-2" />
                  {t('plugins.delete_file')}
                </ContextMenuItem>
              </ContextMenuContent>
            )}
          </ContextMenu>
        ))}

        {creating && (
          <div className="px-2 py-0.5">
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') setCreating(false)
              }}
              onBlur={() => { if (newFileName.trim()) handleCreate(); else setCreating(false) }}
              placeholder={t('plugins.new_file')}
              autoFocus
              className="h-6 text-xs"
            />
          </div>
        )}
      </div>
    </div>
    </TooltipProvider>
  )
}
