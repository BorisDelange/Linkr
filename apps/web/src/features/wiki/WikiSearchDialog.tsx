import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, FileText } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useWikiStore } from '@/stores/wiki-store'
import { useAppStore } from '@/stores/app-store'
import { localized } from '@/lib/localized'
import { isServerMode } from '@/lib/api-client'
import { searchWikiPages, type WikiPageSearchResult } from '@/lib/api/wiki-pages'
import type { LocalizedString } from '@/types'

interface WikiSearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface SearchResultView {
  id: string
  title: LocalizedString
  snippet: string
}

export function WikiSearchDialog({ open, onOpenChange }: WikiSearchDialogProps) {
  const { t } = useTranslation()
  const { searchPages, setActivePage, getBreadcrumbs, getPage, currentWorkspaceId } = useWikiStore()
  const language = useAppStore((s) => s.language)
  const [query, setQuery] = useState('')

  const serverMode = isServerMode()

  const localResults = useMemo<SearchResultView[]>(() => {
    if (serverMode || !query.trim()) return []
    const q = query.trim()
    return searchPages(q).map((p) => {
      const content = localized(p.content, language)
      const idx = content.toLowerCase().indexOf(q.toLowerCase())
      const snippet = idx >= 0
        ? '...' + content.slice(Math.max(0, idx - 30), idx + q.length + 50).trim() + '...'
        : ''
      return { id: p.id, title: p.title, snippet }
    })
  }, [serverMode, query, searchPages, language])

  const [serverResults, setServerResults] = useState<WikiPageSearchResult[]>([])

  useEffect(() => {
    if (!serverMode || !currentWorkspaceId) return
    const q = query.trim()
    let cancelled = false
    const handle = setTimeout(() => {
      if (!q) {
        setServerResults([])
        return
      }
      searchWikiPages(currentWorkspaceId, q)
        .then((res) => { if (!cancelled) setServerResults(res) })
        .catch(() => { if (!cancelled) setServerResults([]) })
    }, 200)
    return () => { cancelled = true; clearTimeout(handle) }
  }, [serverMode, currentWorkspaceId, query])

  const results: SearchResultView[] = serverMode ? serverResults : localResults

  const handleSelect = (pageId: string) => {
    setActivePage(pageId)
    onOpenChange(false)
    setQuery('')
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setQuery('') }}>
      <DialogContent className="max-w-lg gap-0 p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="sr-only">{t('wiki.search')}</DialogTitle>
          <div className="flex items-center gap-2">
            <Search size={16} className="shrink-0 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('wiki.search_placeholder')}
              className="h-8 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
              autoFocus
            />
          </div>
        </DialogHeader>

        <div className="max-h-80 overflow-auto">
          {query.trim() && results.length === 0 && (
            <div className="flex flex-col items-center py-8">
              <Search size={24} className="text-muted-foreground/50" />
              <p className="mt-2 text-xs text-muted-foreground">{t('wiki.no_results')}</p>
            </div>
          )}

          {results.map((result) => {
            const crumbs = getBreadcrumbs(result.id)
            const path = crumbs.map((c) => localized(c.title, language)).join(' / ')

            return (
              <button
                key={result.id}
                type="button"
                onClick={() => handleSelect(result.id)}
                className="flex w-full items-start gap-3 border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-accent"
              >
                <FileText size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {getPage(result.id)?.icon && (
                      <span className="mr-1">{getPage(result.id)?.icon}</span>
                    )}
                    {highlightMatch(localized(result.title, language), query)}
                  </p>
                  {path && <p className="text-[11px] text-muted-foreground">{path}</p>}
                  {result.snippet && (
                    <p className="mt-0.5 text-xs text-muted-foreground/80">
                      {highlightMatch(result.snippet, query)}
                    </p>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <span className="bg-primary/20 font-medium text-primary">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  )
}
