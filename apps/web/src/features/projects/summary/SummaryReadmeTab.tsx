import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import 'katex/dist/katex.min.css'
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
  Sigma,
  HelpCircle,
  Copy,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { useAppStore } from '@/stores/app-store'
import { useReadmeAttachments } from '@/hooks/use-readme-attachments'
import { ReadmeHistoryPanel } from './ReadmeHistoryPanel'
import { ReadmeAttachmentsDialog } from './ReadmeAttachmentsDialog'

export const remarkPlugins = [remarkGfm, remarkMath]

/** Extend default sanitize schema to allow img width/height/alt, blob: URLs, and KaTeX */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), 'alt', 'width', 'height'],
    // KaTeX generates spans/divs with class and style
    span: [...(defaultSchema.attributes?.span ?? []), 'className', 'style'],
    div: [...(defaultSchema.attributes?.div ?? []), 'className', 'style'],
    math: ['xmlns'],
    annotation: ['encoding'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'blob'],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // KaTeX tags
    'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub',
    'msubsup', 'mfrac', 'mover', 'munder', 'munderover', 'msqrt',
    'mroot', 'mtable', 'mtr', 'mtd', 'mtext', 'mspace', 'annotation',
  ],
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const rehypePlugins: any[] = [rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]

/** Allow blob: URLs in addition to default safe protocols */
const safeProtocol = /^(https?|ircs?|mailto|xmpp|blob)$/i
export function urlTransform(value: string): string {
  const colon = value.indexOf(':')
  const questionMark = value.indexOf('?')
  const numberSign = value.indexOf('#')
  const slash = value.indexOf('/')
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    safeProtocol.test(value.slice(0, colon))
  ) {
    return value
  }
  return ''
}

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

  const handleSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    updateProjectReadme(uid, localReadme)
    setMode('view')
  }, [uid, localReadme, updateProjectReadme])

  const handleCancel = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setLocalReadme(readme)
    setMode('view')
  }

  // Cmd/Ctrl+S to save in edit mode
  useEffect(() => {
    if (mode !== 'edit') return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [mode, handleSave])

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
    } else if (format === 'footnote') {
      const ref = `[^1]`
      const def = `\n\n[^1]: Your footnote text`
      replacement = text.substring(0, end) + ref + text.substring(end) + def
      cursorStart = end + ref.length + def.length - 19
      cursorEnd = end + ref.length + def.length
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
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-2 text-xs text-muted-foreground"
            onClick={() => setAttachmentsOpen(true)}
          >
            <Paperclip size={12} />
            {t('summary.attachments')}
          </Button>
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
                <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform}>
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
                <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform}>
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
  | 'math_inline' | 'math_block' | 'footnote'

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
    math_inline:   { before: '$', after: '$', placeholder: 'E = mc^2' },
    math_block:    { before: '$$\n', after: '\n$$', placeholder: '\\sum_{i=1}^{n} x_i' },
    footnote:      { before: '', after: '', placeholder: '' },
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
    { format: 'math_inline', icon: <Sigma size={14} />, label: 'Inline math' },
    { format: 'math_block', icon: <span className="text-[10px] font-bold leading-none">$$</span>, label: 'Math block' },
  ],
  [
    { format: 'footnote', icon: <span className="text-[10px] font-bold leading-none">fn</span>, label: 'Footnote' },
    { format: 'hr', icon: <Minus size={14} />, label: 'Horizontal rule' },
    { format: 'table', icon: <Table size={14} />, label: 'Table' },
  ],
]

function MarkdownToolbar({ onFormat }: { onFormat: (f: MarkdownFormat) => void }) {
  const { t } = useTranslation()

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

        {/* Help button */}
        <Separator orientation="vertical" className="mx-1 h-4" />
        <Dialog>
          <Tooltip>
            <TooltipTrigger asChild>
              <DialogTrigger asChild>
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <HelpCircle size={14} />
                </button>
              </DialogTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {t('summary.markdown_help')}
            </TooltipContent>
          </Tooltip>
          <DialogContent className="max-h-[80vh] max-w-2xl overflow-auto">
            <DialogHeader>
              <DialogTitle>{t('summary.markdown_help')}</DialogTitle>
            </DialogHeader>
            <MarkdownHelpContent />
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text.replace(/\\n/g, '\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground"
    >
      {copied ? <Check size={10} className="text-primary" /> : <Copy size={10} />}
    </button>
  )
}

function MarkdownHelpContent() {
  const { t } = useTranslation()
  const sections: { title: string; rows: [string, string][] }[] = [
    {
      title: t('summary.help_basic'),
      rows: [
        ['# Heading 1', t('summary.help_heading', { level: '1' })],
        ['## Heading 2', t('summary.help_heading', { level: '2' })],
        ['### Heading 3', t('summary.help_heading', { level: '3' })],
        ['**bold**', t('summary.help_bold')],
        ['_italic_', t('summary.help_italic')],
        ['~~strikethrough~~', t('summary.help_strikethrough')],
      ],
    },
    {
      title: t('summary.help_lists'),
      rows: [
        ['- item', t('summary.help_bullet')],
        ['1. item', t('summary.help_numbered')],
        ['- [ ] task', t('summary.help_checklist')],
      ],
    },
    {
      title: t('summary.help_content'),
      rows: [
        ['`code`', t('summary.help_inline_code')],
        ['```\\ncode\\n```', t('summary.help_code_block')],
        ['> quote', t('summary.help_quote')],
        ['[text](url)', t('summary.help_link')],
        ['![alt](url)', t('summary.help_image')],
        ['---', t('summary.help_hr')],
      ],
    },
    {
      title: t('summary.help_tables'),
      rows: [
        ['| A | B |\\n| --- | --- |\\n| 1 | 2 |', t('summary.help_table')],
      ],
    },
    {
      title: t('summary.help_math'),
      rows: [
        ['$E = mc^2$', t('summary.help_inline_math')],
        ['$$\\n\\\\sum_{i=1}^{n} x_i\\n$$', t('summary.help_block_math')],
      ],
    },
    {
      title: t('summary.help_footnotes'),
      rows: [
        ['text[^1]\\n\\n[^1]: note', t('summary.help_footnote')],
      ],
    },
  ]

  return (
    <div className="space-y-4 text-sm">
      {sections.map((section) => (
        <div key={section.title}>
          <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            {section.title}
          </h3>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full">
              <tbody>
                {section.rows.map(([syntax, desc], i) => (
                  <tr key={i} className={i > 0 ? 'border-t' : ''}>
                    <td className="bg-muted/30 px-3 py-1.5">
                      <div className="flex items-start gap-1.5">
                        <code className="flex-1 text-xs whitespace-pre-wrap">{syntax.replace(/\\n/g, '\n')}</code>
                        <CopyButton text={syntax} />
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
