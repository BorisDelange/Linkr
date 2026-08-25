import { useRef, useState } from 'react'
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
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { DialogShell } from '@/components/ui/dialog-shell'
import { InlineRenameField } from '@/components/InlineRenameField'
import {
  matchesSidebarSearch,
  SidebarSearchField,
  SidebarSearchToggle,
  useSidebarSearch,
} from '@/components/SidebarSearch'
import { useOverflowTooltip } from '@/hooks/use-overflow-tooltip'
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

/** File types offered by the New file modal (mirrors the ETL editor's picker). */
const PLUGIN_FILE_TYPES = [
  { id: 'python', ext: '.py', labelKey: 'plugins.file_type_python' },
  { id: 'r', ext: '.R', labelKey: 'plugins.file_type_r' },
  { id: 'py_template', ext: '.py.template', labelKey: 'plugins.file_type_py_template' },
  { id: 'r_template', ext: '.R.template', labelKey: 'plugins.file_type_r_template' },
  { id: 'markdown', ext: '.md', labelKey: 'plugins.file_type_markdown' },
  { id: 'json', ext: '.json', labelKey: 'plugins.file_type_json' },
] as const

interface PluginFileListProps {
  onCollapse?: () => void
  /** When true, hide add/delete/rename file actions (system plugins). */
  readOnly?: boolean
}

export function PluginFileList({ onCollapse, readOnly }: PluginFileListProps) {
  const { t } = useTranslation()
  const { files, activeFile, openFile, createFile, deleteFile, renameFile } = usePluginEditorStore()

  const [createFileOpen, setCreateFileOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [newFileType, setNewFileType] = useState<string>('python')
  const [renamingFile, setRenamingFile] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const search = useSidebarSearch()
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const filenames = Object.keys(files).sort((a, b) => {
    if (a === 'plugin.json') return -1
    if (b === 'plugin.json') return 1
    return a.localeCompare(b)
  })
  const visibleFilenames = filenames.filter((f) => matchesSidebarSearch(f, search.query))

  const openCreateFile = () => {
    setNewFileName('')
    setNewFileType('python')
    setCreateFileOpen(true)
  }

  // Upload one or more files into the plugin (text content read client-side).
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files
    e.target.value = ''
    if (!list || list.length === 0) return
    for (const file of Array.from(list)) {
      if (files[file.name] !== undefined) continue  // skip existing
      const content = await file.text()
      createFile(file.name, content)
    }
  }

  const handleCreate = () => {
    const ext = PLUGIN_FILE_TYPES.find((ft) => ft.id === newFileType)?.ext ?? ''
    const raw = newFileName.trim()
    if (!raw) return
    // Append the type extension unless the user already typed one.
    const name = raw.includes('.') ? raw : `${raw}${ext}`
    if (files[name]) return
    createFile(name)
    setNewFileName('')
    setCreateFileOpen(false)
  }

  const handleRename = (oldName: string, next: string) => {
    if (next !== oldName) renameFile(oldName, next)
    setRenamingFile(null)
  }

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex h-full flex-col border-r">
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          {!readOnly && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={openCreateFile}
                >
                  <FilePlus size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('plugins.new_file_tooltip')}</TooltipContent>
            </Tooltip>
          )}
          {!readOnly && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" onClick={() => uploadInputRef.current?.click()}>
                  <Upload size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('plugins.upload_file')}</TooltipContent>
            </Tooltip>
          )}
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleUpload}
          />
          <SidebarSearchToggle
            open={search.open}
            onToggle={search.toggle}
            label={t('plugins.search_files')}
          />
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
      {search.open && (
        <SidebarSearchField
          value={search.query}
          onChange={search.setQuery}
          onClose={search.toggle}
          placeholder={t('plugins.search_files')}
        />
      )}
      <div className="flex-1 overflow-auto py-1">
        {visibleFilenames.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">{t('plugins.no_files_match')}</p>
        )}
        {visibleFilenames.map((filename) => (
          <PluginFileRow
            key={filename}
            filename={filename}
            icon={getFileIcon(filename)}
            active={activeFile === filename}
            // plugin.json is the manifest: the editor and the store both address
            // it by name, so it can be edited but never renamed or removed.
            locked={filename === 'plugin.json' || !!readOnly}
            renaming={renamingFile === filename}
            onOpen={() => openFile(filename)}
            onStartRename={() => setRenamingFile(filename)}
            onRename={(next) => handleRename(filename, next)}
            onCancelRename={() => setRenamingFile(null)}
            hasClash={(candidate) => files[candidate] !== undefined}
            onDelete={() => setDeleteTarget(filename)}
          />
        ))}
      </div>

      {/* Deleting a file is not undoable once the plugin is saved, so it asks
          first — the IDE tree does the same. */}
      <DialogShell
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title={t('files.delete_confirm_title')}
        description={t('files.delete_confirm_file', { name: deleteTarget ?? '' })}
        onConfirm={() => { if (deleteTarget) deleteFile(deleteTarget); setDeleteTarget(null) }}
        confirmLabel={t('files.delete')}
        destructive
      >
        {null}
      </DialogShell>

      {/* New file modal — same shape as the ETL editor's picker */}
      <Dialog open={createFileOpen} onOpenChange={setCreateFileOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('plugins.new_file_tooltip')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('files.file_type')}</Label>
              <Select value={newFileType} onValueChange={setNewFileType}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLUGIN_FILE_TYPES.map((ft) => (
                    <SelectItem key={ft.id} value={ft.id}>
                      {getFileIcon(`x${ft.ext}`)}
                      <span className="ml-2">
                        {t(ft.labelKey)} <span className="text-muted-foreground">({ft.ext})</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('plugins.file_name')}</Label>
              <Input
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                placeholder={`analysis${PLUGIN_FILE_TYPES.find((ft) => ft.id === newFileType)?.ext ?? ''}`}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate() } }}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateFileOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={!newFileName.trim()}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  )
}

/**
 * One file row, matching the IDE file tree: a fixed-height row so entering
 * rename mode doesn't reflow the list, the full name on hover only when it is
 * actually clipped, and rename/delete on right-click.
 */
function PluginFileRow({
  filename,
  icon,
  active,
  locked,
  renaming,
  onOpen,
  onStartRename,
  onRename,
  onCancelRename,
  hasClash,
  onDelete,
}: {
  filename: string
  icon: React.ReactNode
  active: boolean
  locked: boolean
  renaming: boolean
  onOpen: () => void
  onStartRename: () => void
  onRename: (next: string) => void
  onCancelRename: () => void
  hasClash: (candidate: string) => boolean
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const { ref: nameRef, overflows, triggerProps } = useOverflowTooltip()

  if (renaming) {
    return (
      <div className="flex h-6 w-full min-w-0 items-center gap-1.5 px-3 text-xs">
        {icon}
        <InlineRenameField
          className="-ml-0.5 h-5"
          initialValue={filename}
          onSubmit={onRename}
          onCancel={onCancelRename}
          hasClash={hasClash}
          selectBaseName
        />
      </div>
    )
  }

  return (
    <Tooltip>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onOpen}
              {...triggerProps}
              className={cn(
                'flex h-6 w-full min-w-0 items-center gap-1.5 rounded-sm px-3 text-xs transition-colors',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'text-foreground/80 hover:bg-accent/50',
              )}
            >
              {icon}
              <span ref={nameRef} className="truncate">{filename}</span>
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        {!locked && (
          <ContextMenuContent>
            <ContextMenuItem onClick={onStartRename}>
              <Pencil size={14} />
              {t('plugins.rename_file')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 size={14} />
              {t('plugins.delete_file')}
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>
      {overflows && <TooltipContent side="right">{filename}</TooltipContent>}
    </Tooltip>
  )
}
