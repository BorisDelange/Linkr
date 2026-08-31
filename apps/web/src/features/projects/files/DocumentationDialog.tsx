import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, FileCode2, Package, Search } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { SearchInput } from '@/components/ui/search-input'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MarkdownRenderer } from '@/components/editor/MarkdownRenderer'
import { cn } from '@/lib/utils'
import { docPackages, type DocLanguage, type DocPackage } from '@/lib/docs/linkr-client'

interface DocumentationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Preselects the language, so opening from an R file lands on R. */
  language?: DocLanguage
}

/**
 * The sidebar is one pane showing one of two levels: the package list, or the
 * symbols of the package you drilled into. Two panes side by side would spend a
 * third of a workbench dialog on a list that is one row long today, and the
 * back button reads as the same gesture a file explorer uses.
 */
type View = { level: 'packages' } | { level: 'symbols'; packageId: string; symbolId: string }

export function DocumentationDialog({
  open,
  onOpenChange,
  language: initialLanguage,
}: DocumentationDialogProps) {
  const { t } = useTranslation()
  const [language, setLanguage] = useState<DocLanguage>(initialLanguage ?? 'r')
  const [view, setView] = useState<View>({ level: 'packages' })
  const [query, setQuery] = useState('')

  const packages = useMemo(() => docPackages(language), [language])

  /**
   * Reopening lands on the package list and on the focused file's language,
   * rather than wherever the last reader stopped. Done on close rather than in
   * an effect watching `open`, so it is one state update in the closing event
   * instead of a cascading render every time the dialog mounts.
   */
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setView({ level: 'packages' })
      setQuery('')
      if (initialLanguage) setLanguage(initialLanguage)
    }
    onOpenChange(next)
  }

  const activePackage: DocPackage | undefined =
    view.level === 'symbols' ? packages.find((p) => p.id === view.packageId) : undefined
  /**
   * The two languages document the same calls under different names, so switching
   * language keeps the reader on the same page rather than sending them back to
   * the list — symbol ids are shared across languages for that reason. A symbol
   * with no counterpart (`LinkrError` has none in R) simply resolves to nothing,
   * which renders the package overview.
   */
  const activeSymbol =
    activePackage && view.level === 'symbols'
      ? activePackage.symbols.find((s) => s.id === view.symbolId)
      : undefined

  const needle = query.trim().toLowerCase()
  const filteredPackages = useMemo(
    () =>
      needle
        ? packages.filter(
            (p) =>
              p.name.toLowerCase().includes(needle) ||
              p.summary.toLowerCase().includes(needle) ||
              p.symbols.some((s) => s.name.toLowerCase().includes(needle)),
          )
        : packages,
    [packages, needle],
  )
  const filteredSymbols = useMemo(() => {
    if (!activePackage) return []
    return needle
      ? activePackage.symbols.filter(
          (s) =>
            s.name.toLowerCase().includes(needle) ||
            s.summary.toLowerCase().includes(needle),
        )
      : activePackage.symbols
  }, [activePackage, needle])

  const content = activeSymbol?.body ?? activePackage?.overview

  return (
    <DialogShell
      open={open}
      onOpenChange={handleOpenChange}
      kind="workbench"
      title={t('docs.title')}
      description={t('docs.description')}
      hideFooter
      contentClassName="flex min-h-0 flex-1 gap-0 overflow-hidden"
    >
      <div className="flex w-60 shrink-0 flex-col gap-2 border-r border-border pr-3">
        <Select value={language} onValueChange={(v) => setLanguage(v as DocLanguage)}>
          <SelectTrigger size="xs" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="r">{t('docs.language_r')}</SelectItem>
            <SelectItem value="python">{t('docs.language_python')}</SelectItem>
          </SelectContent>
        </Select>

        <SearchInput
          value={query}
          onChange={setQuery}
          size="dense"
          placeholder={
            view.level === 'packages' ? t('docs.search_packages') : t('docs.search_functions')
          }
        />

        {view.level === 'symbols' && activePackage && (
          <button
            onClick={() => setView({ level: 'packages' })}
            className="flex items-center gap-1 rounded-md px-2 py-1 -mx-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft size={13} />
            {t('docs.back_to_packages')}
          </button>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {view.level === 'packages' ? (
            filteredPackages.length === 0 ? (
              <EmptyState
                icon={Search}
                title={t('docs.no_packages')}
                variant="filtered"
                className="py-8"
              />
            ) : (
              <div className="space-y-0.5">
                {filteredPackages.map((pkg) => (
                  <button
                    key={pkg.id}
                    onClick={() => {
                      setView({ level: 'symbols', packageId: pkg.id, symbolId: '' })
                      setQuery('')
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <Package size={13} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{pkg.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {pkg.summary}
                      </span>
                    </span>
                    <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )
          ) : (
            <div className="space-y-0.5">
              {activePackage && (
                <button
                  onClick={() =>
                    setView({ level: 'symbols', packageId: activePackage.id, symbolId: '' })
                  }
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    !view.symbolId
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <Package size={13} className="shrink-0" />
                  <span className="truncate">{t('docs.overview')}</span>
                </button>
              )}
              {filteredSymbols.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title={t('docs.no_functions')}
                  variant="filtered"
                  className="py-8"
                />
              ) : (
                filteredSymbols.map((sym) => (
                  <button
                    key={sym.id}
                    onClick={() =>
                      setView({
                        level: 'symbols',
                        packageId: activePackage!.id,
                        symbolId: sym.id,
                      })
                    }
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                      view.symbolId === sym.id
                        ? 'bg-accent text-foreground'
                        : 'hover:bg-accent',
                    )}
                  >
                    <FileCode2 size={13} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block truncate font-mono text-xs',
                          view.symbolId === sym.id && 'font-medium',
                        )}
                      >
                        {sym.name}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {sym.summary}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pl-4">
        {content ? (
          <div className="pb-4">
            {activeSymbol && (
              <div className="mb-3 border-b border-border pb-3">
                <code className="text-sm font-medium">{activeSymbol.signature}</code>
              </div>
            )}
            <MarkdownRenderer content={content} className="text-sm" />
          </div>
        ) : (
          <EmptyState
            icon={Package}
            title={t('docs.pick_package')}
            description={t('docs.pick_package_hint')}
          />
        )}
      </div>
    </DialogShell>
  )
}
