import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileStore } from '@/stores/file-store'
import { useAppStore } from '@/stores/app-store'
import { useProjectTree, type TreeNode } from '@/hooks/use-project-tree'
import { FileTreeItem } from './FileTreeItem'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { FileTreeHeader, type FileTreeSort } from '@/components/ui/file-tree-header'
import { treeSearchMatches } from '@/components/SidebarSearch'
import { compareTreeNodes, contentSize } from '@/lib/file-tree-sort'
import { pruneSelection } from '@/lib/tree-selection'

interface FileTreeProps {
  /** Open a create dialog targeting a folder (null = scripts root). */
  onNewChild: (parentId: string | null, folderMode: boolean) => void
  /** Name filter from the explorer's search box; empty shows the whole tree. */
  search?: string
}

export function FileTree({ onNewChild, search = '' }: FileTreeProps) {
  const { t } = useTranslation()
  const { expandedFolders, selectedFileId, moveNode } = useFileStore()
  const activeProjectUid = useAppStore((s) => s.activeProjectUid)
  const { nodes } = useProjectTree(activeProjectUid)
  const [rootDragOver, setRootDragOver] = useState(false)
  const [sort, setSort] = useState<FileTreeSort>({ key: 'name', desc: false })

  const searchMatches = useMemo(() => treeSearchMatches(nodes, search), [nodes, search])

  // Virtual nodes (read-only views of other entities) are hidden from the IDE
  // tree, except those flagged showInIde (the datasets/ subtree), shown read-only.
  function isVisible(node: TreeNode): boolean {
    if (searchMatches && !searchMatches.has(node.id)) return false
    return node.virtual !== true || (node as { showInIde?: true }).showInIde === true
  }

  const sortable = (n: TreeNode) => ({
    name: n.name,
    type: n.type,
    size: contentSize((n as { content?: string }).content),
  })
  const compare = (a: TreeNode, b: TreeNode) => compareTreeNodes(sortable(a), sortable(b), sort)

  // Alphabetical, including at the root: ROOT_ORDER's fixed layout is gone with
  // the 'Custom' column, since a sort the user cannot select is a sort they
  // cannot get back to.
  const rootNodes = nodes
    .filter((f) => f.parentId === null && isVisible(f))
    .sort(compare)

  function getChildren(parentId: string): TreeNode[] {
    return nodes.filter((f) => f.parentId === parentId && isVisible(f)).sort(compare)
  }

  // While searching, every folder on a match's path is forced open — a result
  // buried in a collapsed folder is a result the user cannot see. The store's
  // own expansion is left alone, so closing the search restores it.
  const effectiveExpanded = useMemo(
    () => (searchMatches ? [...new Set([...expandedFolders, ...searchMatches])] : expandedFolders),
    [searchMatches, expandedFolders],
  )

  /**
   * Ids in the order they appear ON SCREEN — what a Shift-range means. A collapsed
   * folder's children are not between two visible rows, so they are not swept in.
   */
  const visibleIds = useMemo(() => {
    const out: string[] = []
    const walk = (list: TreeNode[]) => {
      for (const n of list) {
        out.push(n.id)
        if (n.type === 'folder' && effectiveExpanded.includes(n.id)) walk(getChildren(n.id))
      }
    }
    walk(rootNodes)
    return out
  // rootNodes/getChildren derive from nodes+sort, both listed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, sort, effectiveExpanded])

  // A file deleted or renamed away must not stay selected: a bulk action would
  // then report a count it cannot deliver.
  useEffect(() => {
    const alive = nodes.map((n) => n.id)
    useFileStore.setState((st) => ({ selection: pruneSelection(st.selection, alive) }))
  }, [nodes])

  if (rootNodes.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
        <p className="text-xs text-muted-foreground">
          {searchMatches ? t('files.no_files_match') : t('files.no_files')}
        </p>
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
    if (!draggedId || draggedId.startsWith('virtual:') || draggedId.startsWith('ds-bridge:')) return
    const node = nodes.find((f) => f.id === draggedId)
    if (!node || node.parentId === null) return
    moveNode(draggedId, null)
  }

  return (
    <>
      <FileTreeHeader sort={sort} onChange={setSort} />
    {/* Radix wraps the viewport content in a `display:table` div that grows to the
        widest row, which defeats `truncate` on the file rows. Force that inner div
        back to a plain block so rows are constrained to the sidebar width. */}
    <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block">
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
            expandedFolders={effectiveExpanded}
            selectedFileId={selectedFileId}
            visibleIds={visibleIds}
            onNewChild={onNewChild}
          />
        ))}
      </div>
    </ScrollArea>
    </>
  )
}
