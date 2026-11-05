import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import * as LucideIcons from 'lucide-react'
import {
  Pencil,
  Check,
  X,
  Paperclip,
  ChevronRight,
  ChevronDown,
  Puzzle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MarkdownToolbar, applyMarkdownFormat } from '@/components/editor/MarkdownToolbar'
import type { MarkdownFormat } from '@/components/editor/MarkdownToolbar'
import { MarkdownRenderer, markdownComponents } from '@/components/editor/MarkdownRenderer'
import { useWikiStore } from '@/stores/wiki-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import { useWikiAttachments } from '@/hooks/use-wiki-attachments'
import { cn } from '@/lib/utils'
import { WikiAttachmentsDialog } from './WikiAttachmentsDialog'
import { resolveWikiHref, wikilinkHref } from './wiki-links'
import { WIKI_STATUSES, WIKI_STATUS_DOT } from './wiki-status'
import type { WikiPage, WikiPageStatus } from '@/types'

const SharedLink = markdownComponents.a

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
  const { viewMode, setViewMode, savePage, updatePage, getBreadcrumbs, pages, setActivePage } = useWikiStore()
  const language = useAppStore((s) => s.language)
  const canEdit = useMyWorkspaceRole().atLeast('editor')
  const [localContent, setLocalContent] = useState(() => localized(page.content, language))
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
    if (viewMode !== 'edit') setLocalContent(localized(page.content, language))
  }, [page.content, page.id, viewMode, language])

  // Reset to view mode when page changes
  useEffect(() => {
    setViewMode('view')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id])

  const handleSave = useCallback(() => {
    savePage(page.id, setLocalized(page.content, language, localContent))
    setViewMode('view')
  }, [page.id, page.content, language, localContent, savePage, setViewMode])

  const handleCancel = () => {
    setLocalContent(localized(page.content, language))
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

  const status = page.status ?? 'draft'
  const handleStatusChange = useCallback((next: string) => {
    if (next === status) return
    updatePage(page.id, { status: next as WikiPageStatus, statusChangedAt: new Date().toISOString() })
  }, [page.id, status, updatePage])

  const resolveWikilink = useCallback((name: string): string | null => {
    const target = pages.find((p) => localized(p.title, language).toLowerCase() === name.toLowerCase())
    return target ? wikilinkHref(target.id) : null
  }, [pages, language])

  // Read through refs so the link component keeps one identity: a new one per
  // render would remount every link in the page.
  const pagesRef = useRef(pages)
  const editingRef = useRef(viewMode === 'edit')
  useEffect(() => {
    pagesRef.current = pages
    editingRef.current = viewMode === 'edit'
  }, [pages, viewMode])

  const linkComponents = useMemo(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a: (props: any) => {
      const targetId = resolveWikiHref(props.href, pagesRef.current)
      if (!targetId) return <SharedLink {...props} />
      const { node: _node, children, ...rest } = props
      return (
        <a
          {...rest}
          onClick={(e) => {
            e.preventDefault()
            // Following a link from the live preview would drop the unsaved draft.
            if (!editingRef.current) setActivePage(targetId)
          }}
        >
          {children}
        </a>
      )
    },
  }), [setActivePage])

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
                <span
                  className={`flex items-center gap-0.5 truncate ${crumb.id === page.id ? 'font-medium text-foreground' : 'hover:text-foreground cursor-pointer'}`}
                  onClick={crumb.id === page.id ? undefined : () => setActivePage(crumb.id)}
                >
                  {CrumbIcon && <CrumbIcon size={11} className="shrink-0" />}
                  {localized(crumb.title, language)}
                </span>
              </span>
            )
          })}
        </div>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" disabled={!canEdit} className="h-5 px-2 text-xs text-muted-foreground">
                <span className={cn('size-1.5 rounded-full', WIKI_STATUS_DOT[status])} />
                {t(`wiki.status_${status}`)}
                <ChevronDown size={10} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" density="compact" className="w-40">
              <DropdownMenuRadioGroup value={status} onValueChange={handleStatusChange}>
                {WIKI_STATUSES.map((option) => (
                  <DropdownMenuRadioItem key={option} value={option}>
                    <span className={cn('size-1.5 rounded-full', WIKI_STATUS_DOT[option])} />
                    {t(`wiki.status_${option}`)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

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
                  <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-primary" onClick={handleSave} disabled={localContent === localized(page.content, language)}>
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
                  <Button variant="ghost" size="sm" disabled={!canEdit} className="h-5 px-2 text-xs text-muted-foreground" onClick={() => setViewMode('edit')}>
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
                extraComponents={linkComponents}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-3xl px-6 py-6">
            {/* Page title */}
            <h1 className="text-2xl font-bold text-foreground">{localized(page.title, language)}</h1>
            <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
              <span>{t('wiki.last_updated', { time: updatedAgo })}</span>
              {page.owner && <span>· {page.owner}</span>}
              <span className="flex items-center gap-1.5">
                · <span className={cn('size-1.5 rounded-full', WIKI_STATUS_DOT[status])} />
                {t(`wiki.status_${status}`)}
              </span>
            </div>

            {/* Content */}
            <div className="mt-6">
              {localized(page.content, language) ? (
                <MarkdownRenderer
                  content={resolveAttachmentUrls(localized(page.content, language))}
                  resolveWikilink={resolveWikilink}
                  extraComponents={linkComponents}
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
