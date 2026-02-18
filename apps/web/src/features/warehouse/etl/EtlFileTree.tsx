import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileCode,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Trash2,
  Pencil,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { useEtlStore } from '@/stores/etl-store'
import type { EtlFile } from '@/types'

const LANGUAGE_COLORS: Record<string, string> = {
  sql: 'text-blue-500',
  python: 'text-yellow-500',
  r: 'text-sky-500',
}

function getFileColor(file: EtlFile): string {
  if (file.language) return LANGUAGE_COLORS[file.language] ?? 'text-muted-foreground'
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (ext === 'sql') return 'text-blue-500'
  if (ext === 'py') return 'text-yellow-500'
  if (ext === 'r' || ext === 'rmd') return 'text-sky-500'
  return 'text-muted-foreground'
}

interface Props {
  onRename?: (file: EtlFile) => void
}

export function EtlFileTree({ onRename }: Props) {
  const { t } = useTranslation()
  const { files, selectedFileId, selectFile, deleteFile } = useEtlStore()
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())

  const toggleFolder = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const rootFiles = files.filter((f) => f.parentId === null)
  const getChildren = (parentId: string) =>
    files.filter((f) => f.parentId === parentId).sort((a, b) => a.order - b.order)

  const renderItem = (file: EtlFile, depth: number) => {
    const isActive = file.id === selectedFileId
    const isFolder = file.type === 'folder'
    const isExpanded = expandedFolders.has(file.id)

    return (
      <div key={file.id}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              onClick={() => {
                if (isFolder) toggleFolder(file.id)
                else selectFile(file.id)
              }}
              className={cn(
                'flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs transition-colors hover:bg-accent/50',
                isActive && !isFolder && 'bg-accent text-accent-foreground',
              )}
              style={{ paddingLeft: `${depth * 16 + 8}px` }}
            >
              {isFolder ? (
                <>
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  {isExpanded ? (
                    <FolderOpen size={14} className="text-blue-400" />
                  ) : (
                    <Folder size={14} className="text-blue-400" />
                  )}
                </>
              ) : (
                <>
                  <span className="w-3" />
                  <FileCode size={14} className={getFileColor(file)} />
                </>
              )}
              <span className="truncate">{file.name}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {onRename && (
              <ContextMenuItem onClick={() => onRename(file)}>
                <Pencil size={14} />
                {t('etl.rename')}
              </ContextMenuItem>
            )}
            {onRename && <ContextMenuSeparator />}
            <ContextMenuItem
              variant="destructive"
              onClick={() => deleteFile(file.id)}
            >
              <Trash2 size={14} />
              {t('etl.delete_file')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {isFolder && isExpanded && getChildren(file.id).map((child) => renderItem(child, depth + 1))}
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
        <FileCode size={24} className="text-muted-foreground/50" />
        <p className="mt-2 text-xs text-muted-foreground">{t('etl.no_files')}</p>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="py-1">
        {rootFiles.sort((a, b) => a.order - b.order).map((file) => renderItem(file, 0))}
      </div>
    </ScrollArea>
  )
}
