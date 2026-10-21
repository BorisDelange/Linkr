import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight, ArrowUpDown, ListX, Lock, SquareX, Terminal, X } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { editorTabClass } from '@/components/editor/editor-tab'
import { placeTab } from '@/lib/ide-tab-order'
import { useFileStore, type TerminalTab } from '@/stores/file-store'
import type { TreeNode } from '@/hooks/use-project-tree'
import { getTabIcon } from './OutputPanel'

export type TabGroup = 'left' | 'right'

/** A tab being dragged, and the group it comes from. */
type DragTab = { id: string; kind: 'file' | 'terminal' | 'output'; group: TabGroup }

const CONSOLE_TAB = '__exec_console__'

interface IdeTabBarOptions {
  nodes: TreeNode[]
  /** Every open tab of each panel, in the shared order. */
  leftTabs: string[]
  rightTabs: string[]
  editorVisible: boolean
  setEditorVisible: (visible: boolean) => void
  outputBelow: boolean
  /** Closes a file, asking first when it has unsaved changes. */
  onCloseFile: (fid: string) => void
}

/**
 * The IDE's two tab bars: rendering each tab (file, terminal, output) with its
 * context menu, and dragging any tab within a panel or across to the other one.
 */
export function useIdeTabBar({
  nodes,
  leftTabs,
  rightTabs,
  editorVisible,
  setEditorVisible,
  outputBelow,
  onCloseFile,
}: IdeTabBarOptions) {
  const { t } = useTranslation()
  const leftFileId = useFileStore((s) => s.selectedFileId)
  const openFileIds = useFileStore((s) => s.openFileIds)
  const outputGroupEditorTab = useFileStore((s) => s.outputGroupEditorTab)
  const editorGroupOutputTab = useFileStore((s) => s.editorGroupOutputTab)
  const activeOutputTab = useFileStore((s) => s.activeOutputTab)
  const outputVisible = useFileStore((s) => s.outputVisible)
  const outputTabs = useFileStore((s) => s.outputTabs)
  const outputTabOrder = useFileStore((s) => s.outputTabOrder)
  const terminalTabs = useFileStore((s) => s.terminalTabs)
  const executionCount = useFileStore((s) => s.executionResults.length)
  const _dirtyVersion = useFileStore((s) => s._dirtyVersion)
  const isFileDirty = useFileStore((s) => s.isFileDirty)
  const selectFile = useFileStore((s) => s.selectFile)
  const closeFile = useFileStore((s) => s.closeFile)
  const selectTerminalTab = useFileStore((s) => s.selectTerminalTab)
  const closeTerminalTab = useFileStore((s) => s.closeTerminalTab)
  const setActiveOutputTab = useFileStore((s) => s.setActiveOutputTab)
  const setEditorGroupOutputTab = useFileStore((s) => s.setEditorGroupOutputTab)
  const closeOutputTab = useFileStore((s) => s.closeOutputTab)
  const clearExecutionResults = useFileStore((s) => s.clearExecutionResults)
  const setOutputVisible = useFileStore((s) => s.setOutputVisible)
  const moveOutputTabToEditorGroup = useFileStore((s) => s.moveOutputTabToEditorGroup)
  const moveOutputTabToOutputGroup = useFileStore((s) => s.moveOutputTabToOutputGroup)
  const moveEditorTabToOutputGroup = useFileStore((s) => s.moveEditorTabToOutputGroup)
  const moveEditorTabToEditorGroup = useFileStore((s) => s.moveEditorTabToEditorGroup)
  const setTabOrder = useFileStore((s) => s.setTabOrder)

  const [dragTab, setDragTabState] = useState<DragTab | null>(null)
  // Read by the drag handlers: drag events fire before React re-renders with the
  // state set on dragstart, so a closure over `dragTab` can still see null.
  const dragTabRef = useRef<DragTab | null>(null)
  const setDragTab = useCallback((tab: DragTab | null) => {
    dragTabRef.current = tab
    setDragTabState(tab)
  }, [])
  const [dropGroup, setDropGroup] = useState<TabGroup | null>(null)
  // Where a dragged tab would land: beside which tab, on which side.
  const [dropInsert, setDropInsert] = useState<{ id: string; side: 'left' | 'right' } | null>(null)

  const handleCloseAllFiles = () => {
    for (const fid of openFileIds) closeFile(fid)
  }

  const handleCloseOtherFiles = (keepId: string) => {
    for (const fid of openFileIds) {
      if (fid !== keepId) closeFile(fid)
    }
  }

  const handleCloseAllOutputTabs = () => {
    clearExecutionResults()
    for (const tab of outputTabs) closeOutputTab(tab.id)
  }

  const handleCloseOtherOutputTabs = (keepId: string) => {
    if (keepId === CONSOLE_TAB) {
      for (const tab of outputTabs) closeOutputTab(tab.id)
    } else {
      clearExecutionResults()
      for (const tab of outputTabs) {
        if (tab.id !== keepId) closeOutputTab(tab.id)
      }
    }
  }

  /** Activate a tab within its own group; the other group keeps its selection. */
  const activateOutputTab = (tabId: string, group: TabGroup) => {
    if (group === 'left') {
      setEditorGroupOutputTab(tabId)
      return
    }
    setActiveOutputTab(tabId)
    if (!outputVisible) setOutputVisible(true)
  }

  /** Moves any tab — file, terminal or output — to the other group. */
  const moveTab = (tab: DragTab, target: TabGroup) => {
    if (tab.group === target) return
    if (tab.kind === 'output') {
      if (target === 'left') moveOutputTabToEditorGroup(tab.id)
      else moveOutputTabToOutputGroup(tab.id)
    } else if (target === 'right') {
      moveEditorTabToOutputGroup(tab.id)
    } else {
      moveEditorTabToEditorGroup(tab.id)
      if (!editorVisible) setEditorVisible(true)
    }
  }

  // The dragged tab may re-mount in the other group, and then its own dragend
  // never reaches React: a drop clears every drag marker itself.
  const endTabDrag = () => {
    setDragTab(null)
    setDropGroup(null)
    setDropInsert(null)
  }

  /**
   * Drop target for a tab dragged from the other group: its tab bar and its
   * whole pane. Captured, so a Monaco editor under the pointer cannot take the
   * drop as text; anything but a tab drag passes through untouched.
   */
  const groupDropProps = (group: TabGroup) => ({
    onDragOverCapture: (e: React.DragEvent) => {
      const drag = dragTabRef.current
      if (!drag || drag.group === group) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (dropGroup !== group) setDropGroup(group)
    },
    // Fires on every crossing between children, without a relatedTarget in
    // Chromium: only a pointer outside the box means the drag left the group.
    onDragLeave: (e: React.DragEvent) => {
      const r = e.currentTarget.getBoundingClientRect()
      if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) setDropGroup(null)
    },
    onDropCapture: (e: React.DragEvent) => {
      const drag = dragTabRef.current
      if (!drag || drag.group === group) return
      e.preventDefault()
      e.stopPropagation()
      moveTab(drag, group)
      endTabDrag()
    },
  })

  const tabDragProps = (id: string, kind: DragTab['kind'], group: TabGroup) => ({
    draggable: true,
    'data-tab-id': id,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('application/x-linkr-tab', id)
      e.dataTransfer.effectAllowed = 'move'
      setDragTab({ id, kind, group })
    },
    onDragEnd: endTabDrag,
  })

  const insertMarker = (id: string) =>
    dropInsert?.id === id && dragTab?.id !== id && (
      <div className={cn('absolute top-1 bottom-1 w-0.5 rounded-full bg-primary', dropInsert.side === 'left' ? 'left-0' : 'right-0')} />
    )

  /** The tab under the pointer and the half of it the pointer is on. */
  const tabUnder = (e: React.DragEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tab-id]')
    if (!el?.dataset.tabId) return null
    const r = el.getBoundingClientRect()
    return { id: el.dataset.tabId, side: e.clientX < r.left + r.width / 2 ? 'left' as const : 'right' as const }
  }

  /**
   * A panel's tab bar takes a tab of any kind from either panel and puts it
   * where it is dropped: beside the tab under the pointer, or after the last one.
   */
  const stripDropProps = (group: TabGroup) => ({
    onDragOverCapture: (e: React.DragEvent) => {
      const drag = dragTabRef.current
      if (!drag) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      const at = tabUnder(e)
      if (at?.id !== dropInsert?.id || at?.side !== dropInsert?.side) setDropInsert(at)
      const target = drag.group === group ? null : group
      if (dropGroup !== target) setDropGroup(target)
    },
    onDragLeave: (e: React.DragEvent) => {
      const r = e.currentTarget.getBoundingClientRect()
      if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) {
        setDropInsert(null)
        setDropGroup(null)
      }
    },
    onDropCapture: (e: React.DragEvent) => {
      const drag = dragTabRef.current
      if (!drag) return
      e.preventDefault()
      e.stopPropagation()
      const panelTabs = group === 'left' ? leftTabs : rightTabs
      const at = tabUnder(e) ?? (panelTabs.length ? { id: panelTabs[panelTabs.length - 1], side: 'right' as const } : null)
      moveTab(drag, group)
      if (at) setTabOrder(placeTab([...leftTabs, ...rightTabs], drag.id, at.id, at.side))
      endTabDrag()
    },
  })

  const moveToOtherGroupItem = (tab: DragTab) => (
    <ContextMenuItem onClick={() => moveTab(tab, tab.group === 'left' ? 'right' : 'left')}>
      {outputBelow ? <ArrowUpDown size={14} /> : <ArrowLeftRight size={14} />}
      {t('files.move_to_other_group')}
    </ContextMenuItem>
  )

  const isTabActive = (id: string, group: TabGroup) =>
    group === 'left' ? id === leftFileId && !editorGroupOutputTab : id === outputGroupEditorTab

  const renderOutputTab = (tabId: string, group: TabGroup) => {
    const isActive = group === 'left'
      ? editorGroupOutputTab === tabId
      : activeOutputTab === tabId && outputVisible

    if (tabId === CONSOLE_TAB) {
      return (
        <ContextMenu key={tabId}>
          <ContextMenuTrigger asChild>
            <button
              {...tabDragProps(tabId, 'output', group)}
              onClick={() => activateOutputTab(tabId, group)}
              className={cn(
                editorTabClass(isActive),
                dragTab?.id === tabId && 'opacity-40',
              )}
            >
              {insertMarker(tabId)}
              <span>{t('files.console')}</span>
              <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                {executionCount}
              </span>
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  clearExecutionResults()
                }}
                className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
              >
                <X size={10} />
              </span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {moveToOtherGroupItem({ id: tabId, kind: 'output', group })}
            <ContextMenuItem onClick={() => clearExecutionResults()}>
              <X size={14} />
              {t('files.close')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => handleCloseOtherOutputTabs(tabId)}>
              <ListX size={14} />
              {t('files.close_others')}
            </ContextMenuItem>
            <ContextMenuItem onClick={handleCloseAllOutputTabs}>
              <SquareX size={14} />
              {t('files.close_all')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )
    }

    const tab = outputTabs.find((ot) => ot.id === tabId)
    if (!tab) return null

    return (
      <ContextMenu key={tab.id}>
        <ContextMenuTrigger asChild>
          <button
            {...tabDragProps(tab.id, 'output', group)}
            onClick={() => activateOutputTab(tab.id, group)}
            className={cn(
              editorTabClass(isActive),
              dragTab?.id === tab.id && 'opacity-40',
            )}
          >
            {insertMarker(tab.id)}
            {getTabIcon(tab.type)}
            <span className="max-w-[120px] truncate" title={tab.label}>{tab.label}</span>
            <span
              onClick={(e) => {
                e.stopPropagation()
                closeOutputTab(tab.id)
              }}
              className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
            >
              <X size={10} />
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {moveToOtherGroupItem({ id: tabId, kind: 'output', group })}
          <ContextMenuItem onClick={() => closeOutputTab(tab.id)}>
            <X size={14} />
            {t('files.close')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleCloseOtherOutputTabs(tab.id)}>
            <ListX size={14} />
            {t('files.close_others')}
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCloseAllOutputTabs}>
            <SquareX size={14} />
            {t('files.close_all')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  const renderFileTab = (fid: string, group: TabGroup) => {
    const node = nodes.find((n) => n.id === fid)
    if (!node) return null
    const isActive = isTabActive(fid, group)
    const isVirtual = node.virtual === true
    const isDirty = !isVirtual && _dirtyVersion >= 0 && isFileDirty(fid)
    return (
      <ContextMenu key={fid}>
        <ContextMenuTrigger asChild>
          <button
            {...tabDragProps(fid, 'file', group)}
            onClick={() => {
              selectFile(fid)
              if (group === 'left' && !editorVisible) setEditorVisible(true)
            }}
            className={cn(
              editorTabClass(isActive),
              dragTab?.id === fid && 'opacity-40',
            )}
          >
            {insertMarker(fid)}
            {isVirtual && <Lock size={10} className="text-muted-foreground/50" />}
            <span className="max-w-[140px] truncate" title={node.name}>{node.name}</span>
            {isDirty && (
              <span className="ml-0.5 size-1.5 shrink-0 rounded-full bg-orange-400" />
            )}
            <span
              onClick={(e) => {
                e.stopPropagation()
                onCloseFile(fid)
              }}
              className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
            >
              <X size={10} />
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {moveToOtherGroupItem({ id: fid, kind: 'file', group })}
          <ContextMenuItem onClick={() => onCloseFile(fid)}>
            <X size={14} />
            {t('files.close')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleCloseOtherFiles(fid)}>
            <ListX size={14} />
            {t('files.close_others')}
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCloseAllFiles}>
            <SquareX size={14} />
            {t('files.close_all')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  const renderTerminalTab = (tt: TerminalTab, group: TabGroup) => {
    const isActive = isTabActive(tt.id, group)
    return (
      <ContextMenu key={tt.id}>
        <ContextMenuTrigger asChild>
          <button
            {...tabDragProps(tt.id, 'terminal', group)}
            onClick={() => {
              selectTerminalTab(tt.id)
              if (group === 'left' && !editorVisible) setEditorVisible(true)
            }}
            className={cn(
              editorTabClass(isActive),
              dragTab?.id === tt.id && 'opacity-40',
            )}
          >
            {insertMarker(tt.id)}
            <Terminal size={11} className="text-muted-foreground/70" />
            <span className="max-w-[140px] truncate" title={tt.label}>{tt.label}</span>
            <span
              onClick={(e) => { e.stopPropagation(); closeTerminalTab(tt.id) }}
              className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
            >
              <X size={10} />
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {moveToOtherGroupItem({ id: tt.id, kind: 'terminal', group })}
          <ContextMenuItem onClick={() => closeTerminalTab(tt.id)}>
            <X size={14} />
            {t('files.close')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  const renderTab = (id: string, group: TabGroup) => {
    const tt = terminalTabs.find((x) => x.id === id)
    if (tt) return renderTerminalTab(tt, group)
    if (outputTabOrder.includes(id)) return renderOutputTab(id, group)
    return renderFileTab(id, group)
  }

  /** Tints a panel's pane while a tab from the other panel is dragged over it. */
  const dropHighlight = (group: TabGroup) => dropGroup === group && (
    <div className="pointer-events-none absolute inset-0 z-20 bg-primary/5 ring-2 ring-inset ring-primary/40" />
  )

  return { renderTab, stripDropProps, groupDropProps, dropGroup, dropHighlight }
}
