import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import * as LucideIcons from 'lucide-react'
import {
  ChevronRight,
  Plus,
  FileText,
  FolderOpen,
  Search,
  Pencil,
  Trash2,
  FilePlus,
  Smile,
  Puzzle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
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

function resolveIcon(name: string): LucideIcons.LucideIcon {
  const icon = (LucideIcons as Record<string, unknown>)[name]
  if (typeof icon === 'object' && icon !== null) return icon as LucideIcons.LucideIcon
  return Puzzle
}

interface WikiTreeSidebarProps {
  workspaceId: string
  onCreatePage: (parentId: string | null) => void
  onSearch: () => void
  onChangeIcon: (pageId: string) => void
}

export function WikiTreeSidebar({ workspaceId, onCreatePage, onSearch, onChangeIcon }: WikiTreeSidebarProps) {
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
              onChangeIcon={onChangeIcon}
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
  onChangeIcon: (pageId: string) => void
}

function TreeItem({ node, depth, activePageId, onSelect, onCreateChild, onChangeIcon }: TreeItemProps) {
  const { t } = useTranslation()
  const { updatePage, deletePage } = useWikiStore()
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(node.page.title)
  const renameRef = useRef<HTMLInputElement>(null)
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

  // Focus rename input after context menu closes
  useEffect(() => {
    if (isRenaming) {
      // Delay to let context menu unmount and release focus
      const raf = requestAnimationFrame(() => {
        const el = renameRef.current
        if (el) {
          el.focus()
          const len = el.value.length
          el.setSelectionRange(len, len)
        }
      })
      return () => cancelAnimationFrame(raf)
    }
  }, [isRenaming])

  // Render the icon
  const renderIcon = () => {
    if (node.page.icon) {
      const Icon = resolveIcon(node.page.icon)
      return <Icon size={14} className="shrink-0 text-muted-foreground" />
    }
    if (hasChildren) return <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
    return <FileText size={14} className="shrink-0 text-muted-foreground" />
  }

  const row = (
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

      {renderIcon()}

      {isRenaming ? (
        <input
          ref={renameRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRename()
            if (e.key === 'Escape') setIsRenaming(false)
          }}
          className="min-w-0 flex-1 rounded-sm border border-primary/40 bg-primary/5 px-0.5 text-xs leading-none outline-none"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs">{node.page.title}</span>
      )}
    </div>
  )

  const wrappedRow = (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {row}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        <ContextMenuItem onClick={() => onCreateChild(node.page.id)}>
          <FilePlus size={14} /> {t('wiki.new_child_page')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => { setRenameValue(node.page.title); setIsRenaming(true) }}>
          <Pencil size={14} /> {t('wiki.rename')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onChangeIcon(node.page.id)}>
          <Smile size={14} /> {t('wiki.change_icon')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={handleDelete}>
          <Trash2 size={14} /> {t('wiki.delete_page')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )

  if (hasChildren) {
    return (
      <Collapsible defaultOpen className="group/tree">
        {wrappedRow}
        <CollapsibleContent>
          {node.children.map((child) => (
            <TreeItem
              key={child.page.id}
              node={child}
              depth={depth + 1}
              activePageId={activePageId}
              onSelect={onSelect}
              onCreateChild={onCreateChild}
              onChangeIcon={onChangeIcon}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    )
  }

  return wrappedRow
}
