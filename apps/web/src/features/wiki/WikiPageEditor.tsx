import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import * as LucideIcons from 'lucide-react'
import {
  Pencil,
  Check,
  X,
  History,
  Paperclip,
  Shield,
  ShieldCheck,
  ChevronRight,
  Puzzle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { MarkdownToolbar, applyMarkdownFormat } from '@/components/editor/MarkdownToolbar'
import type { MarkdownFormat } from '@/components/editor/MarkdownToolbar'
import { MarkdownRenderer } from '@/components/editor/MarkdownRenderer'
import { useWikiStore } from '@/stores/wiki-store'
import { useWikiAttachments } from '@/hooks/use-wiki-attachments'
import { WikiAttachmentsDialog } from './WikiAttachmentsDialog'
import { WikiHistoryPanel } from './WikiHistoryPanel'
import type { WikiPage } from '@/types'

function resolveIcon(name: string): LucideIcons.LucideIcon {
  const icon = (LucideIcons as Record<string, unknown>)[name]
  if (typeof icon === 'object' && icon !== null) return icon as LucideIcons.LucideIcon
  return Puzzle
}

interface WikiPageEditorProps {
  page: WikiPage
  workspaceId: string
}

export function WikiPageEditor({ page, workspaceId }: WikiPageEditorProps) {
  const { t } = useTranslation()
  const { viewMode, setViewMode, savePage, updatePage, getBreadcrumbs, pages } = useWikiStore()
  const [localContent, setLocalContent] = useState(page.content)
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const breadcrumbs = getBreadcrumbs(page.id)

  const {
    attachments,
    uploadAttachment,
    deleteAttachment,
    resolveAttachmentUrls,
  } = useWikiAttachments(page.id, workspaceId)

  // Sync local content when page changes
  useEffect(() => {
    if (viewMode !== 'edit') setLocalContent(page.content)
  }, [page.content, page.id, viewMode])

  // Reset to view mode when page changes
  useEffect(() => {
    setViewMode('view')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id])

  const handleSave = useCallback(() => {
    savePage(page.id, localContent)
    setViewMode('view')
  }, [page.id, localContent, savePage, setViewMode])

  const handleCancel = () => {
    setLocalContent(page.content)
    setViewMode('view')
  }

  // Cmd/Ctrl+S to save
  useEffect(() => {
    if (viewMode !== 'edit') return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [viewMode, handleSave])

  const handleFormat = useCallback((format: MarkdownFormat) => {
    const ta = textareaRef.current
    if (!ta) return
    const result = applyMarkdownFormat(ta.value, ta.selectionStart, ta.selectionEnd, format)
    setLocalContent(result.text)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(result.cursorStart, result.cursorEnd)
    })
  }, [])

  const handleToggleVerified = useCallback(() => {
    updatePage(page.id, {
      verified: !page.verified,
      verifiedAt: !page.verified ? new Date().toISOString() : undefined,
    })
  }, [page.id, page.verified, updatePage])

  const handleRestoreVersion = useCallback((snapshotId: string) => {
    const snapshot = page.history.find((s) => s.id === snapshotId)
    if (snapshot) {
      savePage(page.id, snapshot.content)
      setViewMode('view')
    }
  }, [page.id, page.history, savePage, setViewMode])

  // Resolve wikilinks to page IDs
  const resolveWikilink = useCallback((name: string): string | null => {
    const target = pages.find((p) => p.title.toLowerCase() === name.toLowerCase())
    if (target) return `#wiki-page-${target.id}`
    return null
  }, [pages])

  // History mode
  if (viewMode === 'history') {
    return (
      <WikiHistoryPanel
        page={page}
        workspaceId={workspaceId}
        resolveAttachmentUrls={resolveAttachmentUrls}
        onRestore={handleRestoreVersion}
        onClose={() => setViewMode('view')}
      />
    )
  }

  const updatedDate = new Date(page.updatedAt)
  const updatedAgo = formatTimeAgo(updatedDate)

  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumbs + actions bar */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
        <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {breadcrumbs.map((crumb, i) => {
            const CrumbIcon = crumb.icon ? resolveIcon(crumb.icon) : null
            return (
              <span key={crumb.id} className="flex items-center gap-1 min-w-0">
                {i > 0 && <ChevronRight size={10} className="shrink-0" />}
                <span className={`flex items-center gap-0.5 truncate ${crumb.id === page.id ? 'font-medium text-foreground' : 'hover:text-foreground cursor-pointer'}`}>
                  {CrumbIcon && <CrumbIcon size={11} className="shrink-0" />}
                  {crumb.title}
                </span>
              </span>
            )
          })}
        </div>
        <div className="flex items-center gap-1">
          {/* Verified badge */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={`h-5 px-2 text-xs ${page.verified ? 'text-emerald-500' : 'text-muted-foreground'}`}
                onClick={handleToggleVerified}
              >
                {page.verified ? <ShieldCheck size={12} /> : <Shield size={12} />}
                {page.verified ? t('wiki.verified') : t('wiki.verify')}
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={4}>
              {page.verified ? t('wiki.verified') : t('wiki.mark_verified')}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-xs text-muted-foreground"
                onClick={() => setAttachmentsOpen(true)}
              >
                <Paperclip size={12} />
                {t('summary.attachments')}
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={4}>{t('summary.attachments')}</TooltipContent>
          </Tooltip>

          {viewMode === 'edit' ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-muted-foreground" onClick={handleCancel}>
                    <X size={12} /> {t('common.cancel')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={4}>{t('common.cancel')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-primary" onClick={handleSave}>
                    <Check size={12} /> {t('common.save')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={4}>{t('common.save')}</TooltipContent>
              </Tooltip>
            </>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-muted-foreground" onClick={() => setViewMode('history')}>
                    <History size={12} /> {t('summary.history')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={4}>{t('summary.history')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-muted-foreground" onClick={() => setViewMode('edit')}>
                    <Pencil size={12} /> {t('summary.edit')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={4}>{t('summary.edit')}</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      {viewMode === 'edit' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <MarkdownToolbar onFormat={handleFormat} showExtended />
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-0">
            <div className="overflow-auto border-r">
              <textarea
                ref={textareaRef}
                value={localContent}
                onChange={(e) => setLocalContent(e.target.value)}
                placeholder={t('wiki.write_content')}
                className="h-full w-full resize-none border-0 bg-transparent p-4 font-mono text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
                spellCheck={false}
              />
            </div>
            <div className="overflow-auto p-4">
              <MarkdownRenderer
                content={resolveAttachmentUrls(localContent)}
                resolveWikilink={resolveWikilink}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-3xl px-6 py-6">
            {/* Page title */}
            <h1 className="text-2xl font-bold text-foreground">{page.title}</h1>
            <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
              <span>{t('wiki.last_updated', { time: updatedAgo })}</span>
              {page.owner && <span>· {page.owner}</span>}
              {page.verified && (
                <span className="flex items-center gap-1 text-emerald-500">
                  <ShieldCheck size={12} /> {t('wiki.verified')}
                </span>
              )}
            </div>

            {/* Content */}
            <div className="mt-6">
              {page.content ? (
                <MarkdownRenderer
                  content={resolveAttachmentUrls(page.content)}
                  resolveWikilink={resolveWikilink}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{t('wiki.empty_page')}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Attachments dialog */}
      <WikiAttachmentsDialog
        open={attachmentsOpen}
        onOpenChange={setAttachmentsOpen}
        attachments={attachments}
        onUpload={async (file) => { await uploadAttachment(file) }}
        onDelete={async (id) => { await deleteAttachment(id) }}
      />
    </div>
  )
}

function formatTimeAgo(date: Date): string {
  const now = Date.now()
  const diff = now - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 30) return `${days}d ago`
  return date.toLocaleDateString()
}
