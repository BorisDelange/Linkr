import { Info, Lightbulb, AlertTriangle, AlertCircle } from 'lucide-react'
import { ZoomableImage } from '@/components/ImageLightbox'

/**
 * Renderer overrides every markdown view shares. Pass as ReactMarkdown's
 * `components`, so an image is enlargeable and a GitHub alert is styled wherever
 * markdown is rendered — a plugin README, a project summary, a catalog entry, an
 * agent reply.
 *
 * It lives in its own module rather than beside either markdown config: both of
 * them re-export it, and neither should have to depend on the other.
 */
/**
 * A screenshot is legible well before it is page-wide, and the prose around it
 * is `max-w-none` — so on a wide sheet an image stretched to the full column.
 * `!max-w-` because Tailwind Typography styles images as `.prose img`, which
 * outranks a plain utility class. Full size stays one click away in the
 * lightbox.
 */
const IMG_CLASS = '!mx-auto !max-w-full sm:!max-w-[620px] h-auto rounded-md border'

// --- Callouts (GitHub alert syntax) ---

/**
 * `> [!WARNING]` and friends. GitHub renders these as coloured, icon-led boxes;
 * remark-gfm passes them through as a plain blockquote, so they arrive as
 * indistinguishable grey quotes unless we translate them ourselves.
 *
 * Two halves that must travel together: `processCallouts` rewrites the
 * blockquote into a marked `<div>` before parsing, and the `div` override below
 * renders that marker. A view that runs one without the other gets either a raw
 * `<div data-callout>` or an unstyled quote — which is why both are exported
 * from here and applied by every markdown view.
 */
const CALLOUT_REGEX = /^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n((?:> .*(?:\n|$))*)/gm

export function processCallouts(markdown: string): string {
  return markdown.replace(CALLOUT_REGEX, (_match, type: string, body: string) => {
    const content = body.replace(/^> ?/gm, '').trim()
    return `<div data-callout="${type.toLowerCase()}">\n\n${content}\n\n</div>\n`
  })
}

type CalloutStyle = { icon: React.ReactNode; border: string; bg: string; accent: string }

const calloutStyles: Record<string, CalloutStyle> = {
  note: { icon: <Info size={15} />, border: 'border-blue-500/40', bg: 'bg-blue-500/5', accent: 'text-blue-600 dark:text-blue-400' },
  tip: { icon: <Lightbulb size={15} />, border: 'border-emerald-500/40', bg: 'bg-emerald-500/5', accent: 'text-emerald-600 dark:text-emerald-400' },
  important: { icon: <AlertCircle size={15} />, border: 'border-violet-500/40', bg: 'bg-violet-500/5', accent: 'text-violet-600 dark:text-violet-400' },
  warning: { icon: <AlertTriangle size={15} />, border: 'border-amber-500/40', bg: 'bg-amber-500/5', accent: 'text-amber-600 dark:text-amber-400' },
  caution: { icon: <AlertTriangle size={15} />, border: 'border-red-500/40', bg: 'bg-red-500/5', accent: 'text-red-600 dark:text-red-400' },
}

/**
 * Localising these would mean threading i18n through a module every markdown
 * view imports, to translate a keyword the author typed in English in the
 * source. GitHub renders them untranslated too.
 */
const calloutLabels: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const markdownComponents: Record<string, any> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  img: ({ node: _node, className, ...props }: any) => (
    <ZoomableImage {...props} className={className ? `${IMG_CLASS} ${className}` : IMG_CLASS} />
  ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  div: ({ node: _node, children, ...props }: any) => {
    const type = props['data-callout']
    const style = calloutStyles[type]
    if (!style) return <div {...props}>{children}</div>
    return (
      <div className={`my-3 rounded-lg border-l-4 ${style.border} ${style.bg} px-4 py-3`}>
        <div className={`mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${style.accent}`}>
          {style.icon}
          {calloutLabels[type]}
        </div>
        <div className="[&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&>p]:my-2">{children}</div>
      </div>
    )
  },
}
