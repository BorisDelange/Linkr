import { useState, useCallback, useEffect } from 'react'
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
  Settings2,
  Play,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { useAppStore } from '@/stores/app-store'
import { getStorage } from '@/lib/storage'
import type { DatasetColumn } from '@/types'

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
  isRunning?: boolean
  onRun?: () => void
}

export function PluginFileList({ onCollapse, isRunning, onRun }: PluginFileListProps) {
  const { t } = useTranslation()
  const projects = useAppStore((s) => s.projects)
  const {
    files,
    activeFile,
    openFile,
    createFile,
    deleteFile,
    renameFile,
    testLanguage,
    testProjectUid,
    testDatasetFileId,
    setTestLanguage,
    setTestProject,
    setTestDataset,
  } = usePluginEditorStore()

  const [creating, setCreating] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [renamingFile, setRenamingFile] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [datasets, setDatasets] = useState<{ id: string; name: string; columns: DatasetColumn[] }[]>([])

  const loadDatasets = useCallback(async (uid: string) => {
    try {
      const storage = getStorage()
      const dsFiles = await storage.datasetFiles.getByProject(uid)
      const fileDatasets = dsFiles
        .filter((f) => f.type === 'file' && f.columns && f.columns.length > 0)
        .map((f) => ({ id: f.id, name: f.name, columns: f.columns! }))
      setDatasets(fileDatasets)
    } catch {
      setDatasets([])
    }
  }, [])

  const handleProjectChange = useCallback(async (uid: string) => {
    setTestProject(uid)
    await loadDatasets(uid)
  }, [setTestProject, loadDatasets])

  // Load datasets on mount if a project is already selected (e.g. switching plugins)
  useEffect(() => {
    if (testProjectUid) loadDatasets(testProjectUid)
  }, [testProjectUid, loadDatasets])

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
          {onRun && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onRun}
                  disabled={isRunning || !testDatasetFileId}
                >
                  {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('plugins.test_run')}</TooltipContent>
            </Tooltip>
          )}
          {/* Test config popover */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon-xs">
                    <Settings2 size={14} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('plugins.test_config')}</TooltipContent>
            </Tooltip>
            <PopoverContent align="start" className="w-[240px] space-y-3">
              <Label className="text-xs font-medium">{t('plugins.test_config')}</Label>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">{t('plugins.test_select_project')}</Label>
                <Select value={testProjectUid ?? ''} onValueChange={handleProjectChange}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue placeholder={t('plugins.test_select_project')} />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.uid} value={p.uid} className="text-xs">
                        {p.name || p.uid}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {testProjectUid && (
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">{t('plugins.test_select_dataset')}</Label>
                  <Select value={testDatasetFileId ?? ''} onValueChange={setTestDataset}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue placeholder={t('plugins.test_select_dataset')} />
                    </SelectTrigger>
                    <SelectContent>
                      {datasets.map((d) => (
                        <SelectItem key={d.id} value={d.id} className="text-xs">
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">{t('plugins.test_language')}</Label>
                <Select value={testLanguage} onValueChange={(v) => setTestLanguage(v as 'python' | 'r')}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="python" className="text-xs">Python</SelectItem>
                    <SelectItem value="r" className="text-xs">R</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </PopoverContent>
          </Popover>
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
            {filename !== 'plugin.json' && (
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
