import { useTranslation } from 'react-i18next'
import { BookOpen, X } from 'lucide-react'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { MarkdownRenderer } from '@/components/editor/MarkdownRenderer'
import { useResizableSidebar } from '@/hooks/use-resizable-sidebar'
import { localized } from '@/lib/localized'
import type { Plugin } from '@/types/plugin'

// Wider than the dashboard sidebars: this one holds prose, and a tutorial read
// at 340px is a column of broken sentences. Half the viewport, as the concept
// sheets do, bounded so it stays sane on a very small or very wide screen.
const README_MIN_WIDTH = 360
const README_MAX_WIDTH = 1400
const readmeDefaultWidth = () =>
  Math.max(README_MIN_WIDTH, Math.min(README_MAX_WIDTH, Math.round(window.innerWidth * 0.5)))

/**
 * A plugin's README, rendered read-only. Used both inside the picker's sheet and
 * as the widget editor's Doc tab, so the documentation reads the same wherever
 * it is opened.
 */
export function PluginReadmeContent({
  plugin,
  className = 'p-4',
}: {
  plugin: Plugin
  className?: string
}) {
  const { t, i18n } = useTranslation()
  const content = localized(plugin.readme, i18n.language)

  if (!content.trim()) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
        <BookOpen size={28} className="text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">{t('plugins.no_readme')}</p>
      </div>
    )
  }

  return (
    <div className={className}>
      <MarkdownRenderer content={content} />
    </div>
  )
}

/**
 * The README over a plugin picker. The picker is a plain dialog, so a sheet lays
 * over it without stacking two sheets — and the list stays mounted underneath,
 * selection intact, so reading the doc never costs the user their place.
 */
export function PluginReadmeSheet({
  plugin,
  open,
  onOpenChange,
}: {
  plugin: Plugin | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const { width, handleProps } = useResizableSidebar(
    readmeDefaultWidth(),
    README_MAX_WIDTH,
    README_MIN_WIDTH,
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex flex-col gap-0 p-0"
        style={{ width, minWidth: README_MIN_WIDTH, maxWidth: README_MAX_WIDTH }}
      >
        {/* Drag handle on the left edge, as the dashboard sidebars do. */}
        <div
          {...handleProps}
          className="absolute left-0 top-0 z-10 h-full w-1 -translate-x-1/2 cursor-col-resize hover:bg-primary/30"
        />
        <SheetHeader className="shrink-0 flex-row items-center gap-2 space-y-0 border-b px-4 py-2.5">
          <BookOpen size={15} className="shrink-0 text-muted-foreground" />
          <SheetTitle className="min-w-0 flex-1 truncate leading-normal">
            {plugin ? localized(plugin.manifest.name, i18n.language) : ''}
          </SheetTitle>
          {/* The circled grey hover of DialogContent's close, which the default
              sheet close does not carry — centred in the header rather than
              floating at top-4 right-4, so it lines up with the title. */}
          <SheetClose
            aria-label={t('common.close')}
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-70 transition-[opacity,background-color] hover:bg-muted hover:text-foreground hover:opacity-100 focus:outline-hidden"
          >
            <X size={16} />
          </SheetClose>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {plugin && <PluginReadmeContent plugin={plugin} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}
