import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileStore } from '@/stores/file-store'
import { useAppStore } from '@/stores/app-store'
import { useProjectTree, type TreeNode } from '@/hooks/use-project-tree'
import { FileTreeItem } from './FileTreeItem'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

/** Canonical root sort order for the project tree. */
const ROOT_ORDER: Record<string, number> = {
  'project.json': 0,
  'README.md': 1,
  'tasks.json': 2,
  '.gitignore': 3,
  'databases': 4,
  'cohorts': 5,
  'pipeline': 6,
  'scripts': 7,
  'dashboards': 8,
}

function sortNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
  return a.name.localeCompare(b.name)
}

function sortRootNodes(a: TreeNode, b: TreeNode): number {
  const oa = ROOT_ORDER[a.name] ?? 99
  const ob = ROOT_ORDER[b.name] ?? 99
  if (oa !== ob) return oa - ob
  return sortNodes(a, b)
}

export function FileTree() {
  const { t } = useTranslation()
  const { expandedFolders, selectedFileId, moveNode } = useFileStore()
  const activeProjectUid = useAppStore((s) => s.activeProjectUid)
  const { nodes } = useProjectTree(activeProjectUid)
  const [rootDragOver, setRootDragOver] = useState(false)

  const rootNodes = nodes
    .filter((f) => f.parentId === null)
    .sort(sortRootNodes)

  function getChildren(parentId: string): TreeNode[] {
    return nodes.filter((f) => f.parentId === parentId).sort(sortNodes)
  }

  if (rootNodes.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
        <p className="text-xs text-muted-foreground">{t('files.no_files')}</p>
      </div>
    )
  }

  const handleRootDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setRootDragOver(true)
  }

  const handleRootDragLeave = () => {
    setRootDragOver(false)
  }

  const handleRootDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setRootDragOver(false)
    const draggedId = e.dataTransfer.getData('text/plain')
    if (!draggedId || draggedId.startsWith('virtual:')) return
    const node = nodes.find((f) => f.id === draggedId)
    if (!node || node.parentId === null) return
    moveNode(draggedId, null)
  }

  return (
    <ScrollArea className="flex-1">
      <div
        className={cn('min-h-full py-1', rootDragOver && 'bg-accent/30')}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
      >
        {rootNodes.map((node) => (
          <FileTreeItem
            key={node.id}
            node={node}
            depth={0}
            getChildren={getChildren}
            expandedFolders={expandedFolders}
            selectedFileId={selectedFileId}
          />
        ))}
      </div>
    </ScrollArea>
  )
}
