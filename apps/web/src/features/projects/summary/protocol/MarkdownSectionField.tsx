import { useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
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
} from 'lucide-react'
import { remarkPlugins, rehypePlugins, urlTransform } from '../SummaryReadmeTab'
import { applyMarkdownFormat } from '@/components/editor/MarkdownToolbar'
import type { MarkdownFormat } from '@/components/editor/MarkdownToolbar'

interface MarkdownSectionFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  editing: boolean
  label?: string
  /** When true, the editor stretches to fill the parent flex container */
  fill?: boolean
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
    { format: 'hr', icon: <Minus size={14} />, label: 'Horizontal rule' },
    { format: 'table', icon: <Table size={14} />, label: 'Table' },
  ],
]

function SimpleToolbar({ onFormat }: { onFormat: (f: MarkdownFormat) => void }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b px-2 py-1">
      {toolbarGroups.map((group, gi) => (
        <div key={gi} className="flex items-center">
          {gi > 0 && <div className="mx-1 h-4 w-px bg-border" />}
          {group.map(({ format, icon, label }) => (
            <button
              key={format}
              type="button"
              title={label}
              onClick={() => onFormat(format)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {icon}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

export function MarkdownSectionField({ value, onChange, placeholder, editing, label, fill }: MarkdownSectionFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const applyFormat = useCallback(
    (format: MarkdownFormat) => {
      const ta = textareaRef.current
      if (!ta) return

      const { text, cursorStart, cursorEnd } = applyMarkdownFormat(
        ta.value,
        ta.selectionStart,
        ta.selectionEnd,
        format,
      )
      onChange(text)

      requestAnimationFrame(() => {
        ta.focus()
        ta.setSelectionRange(cursorStart, cursorEnd)
      })
    },
    [onChange],
  )

  if (editing) {
    return (
      <div className={`flex flex-col${fill ? ' min-h-0 flex-1' : ''}`}>
        {label && <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>}
        <div className={`flex flex-col overflow-hidden rounded-lg border${fill ? ' min-h-0 flex-1' : ' min-h-[200px]'}`}>
          <SimpleToolbar onFormat={applyFormat} />
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-0">
            <div className="overflow-auto border-r">
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="h-full w-full resize-none border-0 bg-transparent p-3 font-mono text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
                spellCheck={false}
              />
            </div>
            <div className="overflow-auto p-3">
              {value ? (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform}>
                    {value}
                  </ReactMarkdown>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground/50">{placeholder}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!value) return null

  return (
    <div className={fill ? 'min-h-0 flex-1 overflow-auto' : ''}>
      {label && <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>}
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform}>
          {value}
        </ReactMarkdown>
      </div>
    </div>
  )
}
