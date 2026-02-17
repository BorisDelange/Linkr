import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  Plus,
  FileText,
  FolderOpen,
  Search,
  MoreHorizontal,
  Pencil,
  Trash2,
  FilePlus,
  GripVertical,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useWikiStore } from '@/stores/wiki-store'
import type { WikiPage } from '@/types'

interface WikiTreeNode {
  page: WikiPage
  children: WikiTreeNode[]
}

interface WikiTreeSidebarProps {
  workspaceId: string
  onCreatePage: (parentId: string | null) => void
  onSearch: () => void
}

export function WikiTreeSidebar({ workspaceId, onCreatePage, onSearch }: WikiTreeSidebarProps) {
  const { t } = useTranslation()
  const { getTree, activePageId, setActivePage } = useWikiStore()
  const tree = getTree()

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          {t('wiki.pages')}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            onClick={onSearch}
            title={t('wiki.search')}
          >
            <Search size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => onCreatePage(null)}
            title={t('wiki.new_page')}
          >
            <Plus size={14} />
          </Button>
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-auto py-1">
        {tree.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-8 text-center">
            <FileText size={24} className="text-muted-foreground/50" />
            <p className="mt-2 text-xs text-muted-foreground">
              {t('wiki.empty_tree')}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 h-7 text-xs"
              onClick={() => onCreatePage(null)}
            >
              <Plus size={12} />
              {t('wiki.create_first_page')}
            </Button>
          </div>
        ) : (
          tree.map((node) => (
            <TreeItem
              key={node.page.id}
              node={node}
              depth={0}
              activePageId={activePageId}
              onSelect={setActivePage}
              onCreateChild={onCreatePage}
            />
          ))
        )}
      </div>
    </div>
  )
}

// --- Tree Item ---

interface TreeItemProps {
  node: WikiTreeNode
  depth: number
  activePageId: string | null
  onSelect: (id: string) => void
  onCreateChild: (parentId: string | null) => void
}

function TreeItem({ node, depth, activePageId, onSelect, onCreateChild }: TreeItemProps) {
  const { t } = useTranslation()
  const { updatePage, deletePage } = useWikiStore()
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(node.page.title)
  const hasChildren = node.children.length > 0
  const isActive = node.page.id === activePageId

  const handleRename = useCallback(async () => {
    if (renameValue.trim() && renameValue !== node.page.title) {
      await updatePage(node.page.id, { title: renameValue.trim() })
    }
    setIsRenaming(false)
  }, [renameValue, node.page.id, node.page.title, updatePage])

  const handleDelete = useCallback(async () => {
    await deletePage(node.page.id)
  }, [node.page.id, deletePage])

  const content = (
    <div
      className={`group flex items-center gap-1 rounded-md px-1.5 py-1 mx-1 cursor-pointer transition-colors ${
        isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
      }`}
      style={{ paddingLeft: `${depth * 16 + 6}px` }}
      onClick={() => onSelect(node.page.id)}
    >
      {hasChildren ? (
        <CollapsibleTrigger asChild onClick={(e) => e.stopPropagation()}>
          <button className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-accent">
            <ChevronRight size={12} className="transition-transform group-data-[state=open]:rotate-90" />
          </button>
        </CollapsibleTrigger>
      ) : (
        <span className="h-4 w-4 shrink-0" />
      )}

      {node.page.icon ? (
        <span className="shrink-0 text-sm">{node.page.icon}</span>
      ) : hasChildren ? (
        <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
      ) : (
        <FileText size={14} className="shrink-0 text-muted-foreground" />
      )}

      {isRenaming ? (
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRename()
            if (e.key === 'Escape') setIsRenaming(false)
          }}
          className="h-5 flex-1 rounded-sm border-0 bg-transparent px-1 py-0 text-xs focus-visible:ring-1"
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs">{node.page.title}</span>
      )}

      {/* Context menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <button className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100">
            <MoreHorizontal size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[160px]">
          <DropdownMenuItem onClick={() => onCreateChild(node.page.id)}>
            <FilePlus size={14} /> {t('wiki.new_child_page')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => { setRenameValue(node.page.title); setIsRenaming(true) }}>
            <Pencil size={14} /> {t('wiki.rename')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive">
            <Trash2 size={14} /> {t('wiki.delete_page')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  if (hasChildren) {
    return (
      <Collapsible defaultOpen className="group/tree">
        {content}
        <CollapsibleContent>
          {node.children.map((child) => (
            <TreeItem
              key={child.page.id}
              node={child}
              depth={depth + 1}
              activePageId={activePageId}
              onSelect={onSelect}
              onCreateChild={onCreateChild}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    )
  }

  return content
}
