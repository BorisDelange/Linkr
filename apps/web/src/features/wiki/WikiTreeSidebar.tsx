import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import * as LucideIcons from 'lucide-react'
import {
  ChevronRight,
  Plus,
  FileText,
  FolderOpen,
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
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { SidebarSearchField, SidebarSearchToggle } from '@/components/SidebarSearch'
import { useWikiStore } from '@/stores/wiki-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import { isServerMode } from '@/lib/api-client'
import { searchWikiPages } from '@/lib/api/wiki-pages'
import { cn } from '@/lib/utils'
import { WIKI_STATUS_DOT } from './wiki-status'
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
  search: { open: boolean; query: string; setQuery: (q: string) => void; toggle: () => void }
  onCreatePage: (parentId: string | null) => void
  onChangeIcon: (pageId: string) => void
}

export function WikiTreeSidebar({ workspaceId, search, onCreatePage, onChangeIcon }: WikiTreeSidebarProps) {
  const { t } = useTranslation()
  const { getTree, activePageId, setActivePage } = useWikiStore()
  const canEdit = useMyWorkspaceRole().atLeast('editor')
  const tree = getTree()
  const visibleIds = useWikiSearchMatches(workspaceId, search.query)

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-end gap-0.5 border-b px-3 py-1.5">
        <SidebarSearchToggle open={search.open} onToggle={search.toggle} label={t('wiki.search')} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" disabled={!canEdit} onClick={() => onCreatePage(null)}>
              <Plus size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('wiki.new_page')}</TooltipContent>
        </Tooltip>
      </div>

      {search.open && (
        <SidebarSearchField
          value={search.query}
          onChange={search.setQuery}
          onClose={search.toggle}
          placeholder={t('wiki.search_placeholder')}
        />
      )}

      <div className="flex-1 overflow-auto py-1">
        {tree.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-8 text-center">
            <FileText size={24} className="text-muted-foreground/50" />
            <p className="mt-2 text-xs text-muted-foreground">
              {t('wiki.empty_tree')}
            </p>
            <Button
              variant="outline"
              size="sm-tight"
              disabled={!canEdit}
              className="mt-3"
              onClick={() => onCreatePage(null)}
            >
              <Plus size={12} />
              {t('wiki.create_first_page')}
            </Button>
          </div>
        ) : visibleIds?.size === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('wiki.no_results')}</p>
        ) : (
          tree.filter((node) => !visibleIds || visibleIds.has(node.page.id)).map((node) => (
            <TreeItem
              key={node.page.id}
              node={node}
              depth={0}
              activePageId={activePageId}
              visibleIds={visibleIds}
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

/**
 * Pages to show while searching — those whose title or content matches, plus
 * the pages on their path so a deep match stays reachable — or null when the
 * query is empty. In server mode the content is not in the browser, so content
 * matches come from the search endpoint and join the title matches when it answers.
 */
function useWikiSearchMatches(workspaceId: string, query: string): Set<string> | null {
  const { pages, searchPages } = useWikiStore()
  const language = useAppStore((s) => s.language)
  const q = query.trim()
  const serverMode = isServerMode()
  const [serverHits, setServerHits] = useState<{ query: string; ids: string[] }>({ query: '', ids: [] })

  useEffect(() => {
    if (!serverMode || !q) return
    let cancelled = false
    const handle = setTimeout(() => {
      searchWikiPages(workspaceId, q)
        .then((res) => { if (!cancelled) setServerHits({ query: q, ids: res.map((r) => r.id) }) })
        .catch(() => { if (!cancelled) setServerHits({ query: q, ids: [] }) })
    }, 200)
    return () => { cancelled = true; clearTimeout(handle) }
  }, [serverMode, workspaceId, q])

  return useMemo(() => {
    if (!q) return null
    const lower = q.toLowerCase()
    const hits = serverMode
      ? pages.filter((p) => localized(p.title, language).toLowerCase().includes(lower)).map((p) => p.id)
      : searchPages(q).map((p) => p.id)
    if (serverMode && serverHits.query === q) hits.push(...serverHits.ids)

    const byId = new Map(pages.map((p) => [p.id, p]))
    const keep = new Set<string>()
    for (const id of hits) {
      let current = byId.get(id)
      while (current && !keep.has(current.id)) {
        keep.add(current.id)
        current = current.parentId ? byId.get(current.parentId) : undefined
      }
    }
    return keep
  }, [q, serverMode, pages, searchPages, language, serverHits])
}

// --- Tree Item ---

interface TreeItemProps {
  node: WikiTreeNode
  depth: number
  activePageId: string | null
  /** Pages kept by the search; null when not searching. */
  visibleIds: Set<string> | null
  onSelect: (id: string) => void
  onCreateChild: (parentId: string | null) => void
  onChangeIcon: (pageId: string) => void
}

function TreeItem({ node, depth, activePageId, visibleIds, onSelect, onCreateChild, onChangeIcon }: TreeItemProps) {
  const { t } = useTranslation()
  const { updatePage, deletePage } = useWikiStore()
  const language = useAppStore((s) => s.language)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(() => localized(node.page.title, language))
  const renameRef = useRef<HTMLInputElement>(null)
  const [expanded, setExpanded] = useState(true)
  const children = visibleIds ? node.children.filter((c) => visibleIds.has(c.page.id)) : node.children
  const hasChildren = children.length > 0
  const isActive = node.page.id === activePageId
  const status = node.page.status ?? 'draft'

  const handleRename = useCallback(async () => {
    if (renameValue.trim() && renameValue !== localized(node.page.title, language)) {
      await updatePage(node.page.id, { title: setLocalized(node.page.title, language, renameValue.trim()) })
    }
    setIsRenaming(false)
  }, [renameValue, node.page.id, node.page.title, language, updatePage])

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
          el.select()  // select all so typing replaces the name outright
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
        <span className={cn('min-w-0 flex-1 truncate text-xs', status === 'draft' && 'text-muted-foreground')}>
          {localized(node.page.title, language)}
        </span>
      )}
      {status !== 'approved' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="-my-1 mr-0.5 flex shrink-0 items-center self-stretch px-0.5">
              <span className={cn('size-1.5 rounded-full', WIKI_STATUS_DOT[status])} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{t(`wiki.status_${status}`)}</TooltipContent>
        </Tooltip>
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
        <ContextMenuItem onClick={() => { setRenameValue(localized(node.page.title, language)); setIsRenaming(true) }}>
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
      // Forced open while searching: a match inside a collapsed folder is one the user cannot see.
      <Collapsible open={expanded || !!visibleIds} onOpenChange={setExpanded} className="group/tree">
        {wrappedRow}
        <CollapsibleContent>
          {children.map((child) => (
            <TreeItem
              key={child.page.id}
              node={child}
              depth={depth + 1}
              activePageId={activePageId}
              visibleIds={visibleIds}
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
