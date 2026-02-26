import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { BookOpen } from 'lucide-react'
import { useWikiStore } from '@/stores/wiki-store'
import { WikiTreeSidebar } from './WikiTreeSidebar'
import { WikiPageEditor } from './WikiPageEditor'
import { WikiSearchDialog } from './WikiSearchDialog'
import { CreateWikiPageDialog } from './CreateWikiPageDialog'
import { WikiIconDialog } from './WikiIconDialog'
import { WikiHistoryDialog } from './WikiHistoryDialog'

export function WikiPage() {
  const { t } = useTranslation()
  const { wsUid } = useParams<{ wsUid: string }>()
  const {
    pagesLoaded,
    loadPages,
    currentWorkspaceId,
    activePageId,
    getPage,
    updatePage,
  } = useWikiStore()

  const [searchOpen, setSearchOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createParentId, setCreateParentId] = useState<string | null>(null)
  const [iconDialogPageId, setIconDialogPageId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  // Load wiki pages when workspace changes
  useEffect(() => {
    if (wsUid && wsUid !== currentWorkspaceId) {
      loadPages(wsUid)
    }
  }, [wsUid, currentWorkspaceId, loadPages])

  const activePage = activePageId ? getPage(activePageId) : undefined

  const handleCreatePage = (parentId: string | null) => {
    setCreateParentId(parentId)
    setCreateOpen(true)
  }

  // Keyboard shortcut: Cmd/Ctrl+K for search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (!wsUid || !pagesLoaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Tree sidebar */}
      <div className="w-64 shrink-0 overflow-hidden border-r bg-muted/30">
        <WikiTreeSidebar
          workspaceId={wsUid}
          onCreatePage={handleCreatePage}
          onSearch={() => setSearchOpen(true)}
          onHistory={() => setHistoryOpen(true)}
          onChangeIcon={(pageId) => setIconDialogPageId(pageId)}
        />
      </div>

      {/* Content area */}
      <div className="min-w-0 flex-1 overflow-hidden">
        {activePage ? (
          <WikiPageEditor page={activePage} workspaceId={wsUid} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <BookOpen size={48} className="text-muted-foreground/30" />
            <h2 className="mt-4 text-lg font-semibold text-foreground">{t('wiki.title')}</h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {t('wiki.select_or_create')}
            </p>
            <p className="mt-3 text-xs text-muted-foreground/60">
              {t('wiki.search_shortcut')}
            </p>
          </div>
        )}
      </div>

      {/* Dialogs */}
      <WikiSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <CreateWikiPageDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspaceId={wsUid}
        parentId={createParentId}
      />
      <WikiIconDialog
        pageId={iconDialogPageId}
        currentIcon={iconDialogPageId ? getPage(iconDialogPageId)?.icon : undefined}
        onClose={() => setIconDialogPageId(null)}
        onChange={(icon) => {
          if (iconDialogPageId) updatePage(iconDialogPageId, { icon })
          setIconDialogPageId(null)
        }}
      />
      <WikiHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        workspaceId={wsUid}
      />
    </div>
  )
}
