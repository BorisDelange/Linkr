import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Pencil,
  Check,
  X,
  Bold,
  Italic,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Code,
  Quote,
  Link as LinkIcon,
  Image,
  Minus,
  Table,
  History,
  Paperclip,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { useAppStore } from '@/stores/app-store'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { ReadmeHistoryPanel } from './ReadmeHistoryPanel'
import { ReadmeAttachmentsDialog } from './ReadmeAttachmentsDialog'

interface SummaryReadmeTabProps {
  uid: string
}

type ViewMode = 'view' | 'edit' | 'history'

export function SummaryReadmeTab({ uid }: SummaryReadmeTabProps) {
  const { t } = useTranslation()
  const { _projectsRaw, updateProjectReadme, restoreReadmeVersion } = useAppStore()
  const project = _projectsRaw.find((p) => p.uid === uid)
  const readme = project?.readme ?? ''
  const readmeHistory = project?.readmeHistory ?? []

  const [mode, setMode] = useState<ViewMode>('view')
  const [localReadme, setLocalReadme] = useState(readme)
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const {
    attachments,
    uploadAttachment,
    deleteAttachment,
    resolveAttachmentUrls,
  } = useReadmeAttachments(uid)

  useEffect(() => {
    if (mode !== 'edit') setLocalReadme(readme)
  }, [readme, mode])

  const handleSave = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    updateProjectReadme(uid, localReadme)
    setMode('view')
  }

  const handleCancel = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setLocalReadme(readme)
    setMode('view')
  }

  const handleRestore = (snapshotId: string) => {
    restoreReadmeVersion(uid, snapshotId)
    setMode('view')
  }

  const applyFormat = useCallback((format: MarkdownFormat) => {
    const ta = textareaRef.current
    if (!ta) return

    const start = ta.selectionStart
    const end = ta.selectionEnd
    const text = ta.value
    const selected = text.substring(start, end)

    const { before, after, placeholder, newlinePrefix } = getFormatTokens(format)

    let replacement: string
    let cursorStart: number
    let cursorEnd: number

    if (newlinePrefix) {
      if (selected) {
        const prefixed = selected
          .split('\n')
          .map((line) => `${newlinePrefix}${line}`)
          .join('\n')
        replacement = text.substring(0, start) + prefixed + text.substring(end)
        cursorStart = start
        cursorEnd = start + prefixed.length
      } else {
        const lineStart = text.lastIndexOf('\n', start - 1) + 1
        replacement =
          text.substring(0, lineStart) +
          newlinePrefix +
          text.substring(lineStart)
        cursorStart = cursorEnd = lineStart + newlinePrefix.length + (start - lineStart)
      }
    } else if (format === 'table') {
      const tableTemplate = '\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| | | |\n'
      replacement = text.substring(0, start) + tableTemplate + text.substring(end)
      cursorStart = cursorEnd = start + tableTemplate.length
    } else if (format === 'hr') {
      const hr = '\n\n---\n\n'
      replacement = text.substring(0, start) + hr + text.substring(end)
      cursorStart = cursorEnd = start + hr.length
    } else if (format === 'link') {
      if (selected) {
        const insert = `[${selected}](url)`
        replacement = text.substring(0, start) + insert + text.substring(end)
        cursorStart = start + selected.length + 3
        cursorEnd = cursorStart + 3
      } else {
        const insert = `[${placeholder}](url)`
        replacement = text.substring(0, start) + insert + text.substring(end)
        cursorStart = start + 1
        cursorEnd = start + 1 + placeholder.length
      }
    } else if (format === 'image') {
      const label = selected || placeholder
      const insert = `![${label}](url)`
      replacement = text.substring(0, start) + insert + text.substring(end)
      if (selected) {
        cursorStart = start + selected.length + 4
        cursorEnd = cursorStart + 3
      } else {
        cursorStart = start + 2
        cursorEnd = start + 2 + placeholder.length
      }
    } else {
      if (selected) {
        replacement =
          text.substring(0, start) +
          before + selected + after +
          text.substring(end)
        cursorStart = start + before.length
        cursorEnd = cursorStart + selected.length
      } else {
        replacement =
          text.substring(0, start) +
          before + placeholder + after +
          text.substring(end)
        cursorStart = start + before.length
        cursorEnd = cursorStart + placeholder.length
      }
    }

    setLocalReadme(replacement)

    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(cursorStart, cursorEnd)
    })
  }, [])

  // History mode
  if (mode === 'history') {
    return (
      <ReadmeHistoryPanel
        history={readmeHistory}
        currentReadme={readme}
        resolveAttachmentUrls={resolveAttachmentUrls}
        onRestore={handleRestore}
        onClose={() => setMode('view')}
      />
    )
  }

  return (
    <div className="flex h-full flex-col pt-2">
      {/* Header bar */}
      <div className="flex shrink-0 items-center justify-between">
        <h2 className="text-xs font-semibold uppercase text-muted-foreground">
          {t('summary.readme')}
        </h2>
        <div className="flex items-center gap-1">
          {mode === 'edit' ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-xs text-muted-foreground"
                onClick={handleCancel}
              >
                <X size={12} />
                {t('common.cancel')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-xs text-primary"
                onClick={handleSave}
              >
                <Check size={12} />
                {t('common.save')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-xs text-muted-foreground"
                onClick={() => setAttachmentsOpen(true)}
              >
                <Paperclip size={12} />
                {t('summary.attachments')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-xs text-muted-foreground"
                onClick={() => setMode('history')}
              >
                <History size={12} />
                {t('summary.history')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-xs text-muted-foreground"
                onClick={() => setMode('edit')}
              >
                <Pencil size={12} />
                {t('summary.edit')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      {mode === 'edit' ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
          <MarkdownToolbar onFormat={applyFormat} />
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-0">
            <div className="overflow-auto border-r">
              <textarea
                ref={textareaRef}
                value={localReadme}
                onChange={(e) => setLocalReadme(e.target.value)}
                placeholder={t('summary.readme_placeholder')}
                className="h-full w-full resize-none border-0 bg-transparent p-4 font-mono text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
                spellCheck={false}
              />
            </div>
            <div className="overflow-auto p-4">
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {resolveAttachmentUrls(localReadme)}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="h-full overflow-auto p-4">
            {readme ? (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {resolveAttachmentUrls(readme)}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('summary.no_readme')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Attachments dialog */}
      <ReadmeAttachmentsDialog
        open={attachmentsOpen}
        onOpenChange={setAttachmentsOpen}
        attachments={attachments}
        onUpload={async (file) => { await uploadAttachment(file) }}
        onDelete={async (id) => { await deleteAttachment(id) }}
      />
    </div>
  )
}

// --- Markdown formatting ---

type MarkdownFormat =
  | 'bold' | 'italic' | 'strikethrough'
  | 'h1' | 'h2' | 'h3'
  | 'ul' | 'ol' | 'checklist'
  | 'code' | 'codeblock' | 'quote'
  | 'link' | 'image' | 'hr' | 'table'

function getFormatTokens(format: MarkdownFormat) {
  const m: Record<MarkdownFormat, { before: string; after: string; placeholder: string; newlinePrefix?: string }> = {
    bold:          { before: '**', after: '**', placeholder: 'bold text' },
    italic:        { before: '_', after: '_', placeholder: 'italic text' },
    strikethrough: { before: '~~', after: '~~', placeholder: 'strikethrough' },
    h1:            { before: '', after: '', placeholder: '', newlinePrefix: '# ' },
    h2:            { before: '', after: '', placeholder: '', newlinePrefix: '## ' },
    h3:            { before: '', after: '', placeholder: '', newlinePrefix: '### ' },
    ul:            { before: '', after: '', placeholder: '', newlinePrefix: '- ' },
    ol:            { before: '', after: '', placeholder: '', newlinePrefix: '1. ' },
    checklist:     { before: '', after: '', placeholder: '', newlinePrefix: '- [ ] ' },
    code:          { before: '`', after: '`', placeholder: 'code' },
    codeblock:     { before: '```\n', after: '\n```', placeholder: 'code' },
    quote:         { before: '', after: '', placeholder: '', newlinePrefix: '> ' },
    link:          { before: '[', after: '](url)', placeholder: 'link text' },
    image:         { before: '![', after: '](url)', placeholder: 'alt text' },
    hr:            { before: '\n---\n', after: '', placeholder: '' },
    table:         { before: '', after: '', placeholder: '' },
  }
  return m[format]
}

const toolbarGroups: { format: MarkdownFormat; icon: React.ReactNode; label: string }[][] = [
  [
    { format: 'h1', icon: <Heading1 size={14} />, label: 'Heading 1' },
    { format: 'h2', icon: <Heading2 size={14} />, label: 'Heading 2' },
    { format: 'h3', icon: <Heading3 size={14} />, label: 'Heading 3' },
  ],
  [
    { format: 'bold', icon: <Bold size={14} />, label: 'Bold' },
    { format: 'italic', icon: <Italic size={14} />, label: 'Italic' },
    { format: 'strikethrough', icon: <Strikethrough size={14} />, label: 'Strikethrough' },
  ],
  [
    { format: 'ul', icon: <List size={14} />, label: 'Bullet list' },
    { format: 'ol', icon: <ListOrdered size={14} />, label: 'Numbered list' },
    { format: 'checklist', icon: <CheckSquare size={14} />, label: 'Checklist' },
  ],
  [
    { format: 'code', icon: <Code size={14} />, label: 'Inline code' },
    { format: 'quote', icon: <Quote size={14} />, label: 'Quote' },
    { format: 'link', icon: <LinkIcon size={14} />, label: 'Link' },
    { format: 'image', icon: <Image size={14} />, label: 'Image' },
  ],
  [
    { format: 'hr', icon: <Minus size={14} />, label: 'Horizontal rule' },
    { format: 'table', icon: <Table size={14} />, label: 'Table' },
  ],
]

function MarkdownToolbar({ onFormat }: { onFormat: (f: MarkdownFormat) => void }) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex shrink-0 items-center gap-0.5 border-b px-2 py-1">
        {toolbarGroups.map((group, gi) => (
          <div key={gi} className="flex items-center">
            {gi > 0 && (
              <Separator orientation="vertical" className="mx-1 h-4" />
            )}
            {group.map(({ format, icon, label }) => (
              <Tooltip key={format}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onFormat(format)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {icon}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {label}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        ))}
      </div>
    </TooltipProvider>
  )
}
