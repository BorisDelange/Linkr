import { useTranslation } from 'react-i18next'
import { BookOpen } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { MarkdownRenderer } from '@/components/editor/MarkdownRenderer'
import { localized } from '@/lib/localized'
import type { Plugin } from '@/types/plugin'

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
  const { i18n } = useTranslation()

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="shrink-0 border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2">
            <BookOpen size={15} className="shrink-0 text-muted-foreground" />
            {plugin ? localized(plugin.manifest.name, i18n.language) : ''}
          </SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {plugin && <PluginReadmeContent plugin={plugin} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}
