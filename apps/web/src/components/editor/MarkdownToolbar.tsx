import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
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
  Sigma,
  HelpCircle,
  Copy,
  Check,
  Info,
  AlertTriangle,
  Lightbulb,
  AlertCircle,
} from 'lucide-react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'

// --- Markdown formatting types ---

export type MarkdownFormat =
  | 'bold' | 'italic' | 'strikethrough'
  | 'h1' | 'h2' | 'h3'
  | 'ul' | 'ol' | 'checklist'
  | 'code' | 'codeblock' | 'quote'
  | 'link' | 'image' | 'hr' | 'table'
  | 'math_inline' | 'math_block' | 'footnote'
  | 'callout_note' | 'callout_tip' | 'callout_important' | 'callout_warning'
  | 'mermaid' | 'details' | 'toc'

export function getFormatTokens(format: MarkdownFormat) {
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
    callout_note:  { before: '> [!NOTE]\n', after: '', placeholder: '', newlinePrefix: '> ' },
    callout_tip:   { before: '> [!TIP]\n', after: '', placeholder: '', newlinePrefix: '> ' },
    callout_important: { before: '> [!IMPORTANT]\n', after: '', placeholder: '', newlinePrefix: '> ' },
    callout_warning:   { before: '> [!WARNING]\n', after: '', placeholder: '', newlinePrefix: '> ' },
    mermaid:       { before: '```mermaid\n', after: '\n```', placeholder: 'graph TD\n    A --> B' },
    details:       { before: '<details>\n<summary>Click to expand</summary>\n\n', after: '\n\n</details>', placeholder: 'Hidden content here' },
    toc:           { before: '[[toc]]', after: '', placeholder: '' },
  }
  return m[format]
}

/**
 * Apply a markdown format to a textarea.
 * Returns { text, cursorStart, cursorEnd } for the replacement.
 */
export function applyMarkdownFormat(
  text: string,
  start: number,
  end: number,
  format: MarkdownFormat,
): { text: string; cursorStart: number; cursorEnd: number } {
  const selected = text.substring(start, end)
  const { before, after, placeholder, newlinePrefix } = getFormatTokens(format)

  let replacement: string
  let cursorStart: number
  let cursorEnd: number

  if (newlinePrefix && format !== 'callout_note' && format !== 'callout_tip' && format !== 'callout_important' && format !== 'callout_warning') {
    if (selected) {
      const prefixed = selected.split('\n').map((line) => `${newlinePrefix}${line}`).join('\n')
      replacement = text.substring(0, start) + prefixed + text.substring(end)
      cursorStart = start
      cursorEnd = start + prefixed.length
    } else {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1
      replacement = text.substring(0, lineStart) + newlinePrefix + text.substring(lineStart)
      cursorStart = cursorEnd = lineStart + newlinePrefix.length + (start - lineStart)
    }
  } else if (format.startsWith('callout_')) {
    const type = format.replace('callout_', '').toUpperCase()
    const calloutText = selected || 'Your note here'
    const block = `> [!${type}]\n> ${calloutText}\n`
    replacement = text.substring(0, start) + block + text.substring(end)
    cursorStart = start + `> [!${type}]\n> `.length
    cursorEnd = cursorStart + calloutText.length
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
  } else if (format === 'toc') {
    const toc = '[[toc]]\n'
    replacement = text.substring(0, start) + toc + text.substring(end)
    cursorStart = cursorEnd = start + toc.length
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
      replacement = text.substring(0, start) + before + selected + after + text.substring(end)
      cursorStart = start + before.length
      cursorEnd = cursorStart + selected.length
    } else {
      replacement = text.substring(0, start) + before + placeholder + after + text.substring(end)
      cursorStart = start + before.length
      cursorEnd = cursorStart + placeholder.length
    }
  }

  return { text: replacement, cursorStart, cursorEnd }
}

// --- Toolbar UI ---

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

interface MarkdownToolbarProps {
  onFormat: (f: MarkdownFormat) => void
  showExtended?: boolean
}

export function MarkdownToolbar({ onFormat, showExtended = false }: MarkdownToolbarProps) {
  const { t } = useTranslation()

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b px-2 py-1">
        {toolbarGroups.map((group, gi) => (
          <div key={gi} className="flex items-center">
            {gi > 0 && <Separator orientation="vertical" className="mx-1 h-4" />}
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
                <TooltipContent side="bottom" className="text-xs">{label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        ))}

        {/* Extended toolbar: callouts, mermaid, details, toc */}
        {showExtended && (
          <>
            <Separator orientation="vertical" className="mx-1 h-4" />
            {/* Callouts dropdown */}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Info size={14} />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">{t('wiki.callouts')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" className="min-w-[140px]">
                <DropdownMenuItem onClick={() => onFormat('callout_note')}>
                  <Info size={14} className="text-blue-500" /> Note
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onFormat('callout_tip')}>
                  <Lightbulb size={14} className="text-emerald-500" /> Tip
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onFormat('callout_important')}>
                  <AlertCircle size={14} className="text-violet-500" /> Important
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onFormat('callout_warning')}>
                  <AlertTriangle size={14} className="text-amber-500" /> Warning
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Mermaid diagram */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onFormat('mermaid')}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <span className="text-[10px] font-bold leading-none">◇</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Mermaid diagram</TooltipContent>
            </Tooltip>

            {/* Collapsible block */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onFormat('details')}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <span className="text-[10px] font-bold leading-none">▸</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{t('wiki.collapsible')}</TooltipContent>
            </Tooltip>

            {/* TOC */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onFormat('toc')}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <span className="text-[10px] font-bold leading-none">TOC</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{t('wiki.table_of_contents')}</TooltipContent>
            </Tooltip>
          </>
        )}

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
            <TooltipContent side="bottom" className="text-xs">{t('summary.markdown_help')}</TooltipContent>
          </Tooltip>
          <DialogContent className="max-h-[80vh] max-w-2xl overflow-auto">
            <DialogHeader>
              <DialogTitle>{t('summary.markdown_help')}</DialogTitle>
            </DialogHeader>
            <MarkdownHelpContent showExtended={showExtended} />
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}

// --- Help Content ---

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

function MarkdownHelpContent({ showExtended = false }: { showExtended?: boolean }) {
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

  if (showExtended) {
    sections.push(
      {
        title: t('summary.help_alerts'),
        rows: [
          ['> [!NOTE]\\n> text', t('wiki.help_callout_note')],
          ['> [!TIP]\\n> text', t('wiki.help_callout_tip')],
          ['> [!WARNING]\\n> text', t('wiki.help_callout_warning')],
        ],
      },
      {
        title: t('wiki.help_advanced'),
        rows: [
          ['```mermaid\\ngraph TD\\n  A --> B\\n```', t('wiki.help_mermaid')],
          ['<details>\\n<summary>Title</summary>\\n\\nContent\\n\\n</details>', t('wiki.help_details')],
          ['[[toc]]', t('wiki.help_toc')],
          ['[[Page Name]]', t('wiki.help_wikilink')],
        ],
      },
    )
  }

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
