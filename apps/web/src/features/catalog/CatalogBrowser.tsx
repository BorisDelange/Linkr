/**
 * The catalog's browse surface: toolbar (search + filters + sort) over a grid of entry
 * cards. Rendered both by the Catalog page and by the import dialog's catalog tab, so
 * the two are the same UI rather than two implementations that drift.
 *
 * Everything specific to *where* it is rendered stays with the caller: the page header,
 * the workspace picker, the refresh control, and the install dialogs. This component
 * only browses and delegates install.
 *
 * When `lockedType` is set (the import dialog, which is opened from a page that already
 * chose a type) the type filter disappears — the entries are pre-filtered to that type,
 * so the control could only ever narrow to nothing.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card } from '@/components/ui/card'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import { localized } from '@/lib/localized'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { ENTRY_TYPES, ENTRY_TYPE_META } from '@/lib/catalog/entry-meta'
import type { InstalledInfo } from '@/lib/catalog/installed'
import type { CatalogEntry, CatalogEntryType } from '@/lib/catalog/types'
import { CatalogEntryCard } from './CatalogEntryCard'

/** Organization label used by the filter list, the filter test and the search haystack. */
function orgNameOf(entry: CatalogEntry, language: string): string {
  return localized(entry.organization?.name, language) || ''
}

interface CatalogBrowserProps {
  entries: CatalogEntry[]
  language: string
  installed: Record<string, InstalledInfo>
  serverMode: boolean
  hasWorkspace: boolean
  busyId: string | null
  onInstall: (entry: CatalogEntry) => void
  /** Open the installed copy in the app; per entry, absent when it has no detail route. */
  openInApp: (entry: CatalogEntry) => (() => void) | undefined
  /** Hide the type filter — the caller already narrowed to a single type. */
  lockedType?: CatalogEntryType
  /** Extra controls for the toolbar (the page puts its workspace picker here). */
  toolbarExtra?: React.ReactNode
  /** Grid column classes; the dialog is wider than the page's two columns. */
  gridClassName?: string
  className?: string
}

export function CatalogBrowser({
  entries,
  language,
  installed,
  serverMode,
  hasWorkspace,
  busyId,
  onInstall,
  openInApp,
  lockedType,
  toolbarExtra,
  gridClassName = 'sm:grid-cols-2',
  className,
}: CatalogBrowserProps) {
  const { t } = useTranslation()

  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string[]>([])
  const [badgeFilter, setBadgeFilter] = useState<string[]>([])
  const [authorFilter, setAuthorFilter] = useState<string[]>([])
  const [orgFilter, setOrgFilter] = useState<string[]>([])
  const [sort, setSort] = useState<SortState | null>(null)

  const allBadges = useMemo(
    () => [...new Set(entries.flatMap((e) => e.badges ?? []))].sort(),
    [entries],
  )
  const allAuthors = useMemo(
    () => [...new Set(entries.map((e) => e.author?.name).filter((n): n is string => !!n))].sort(),
    [entries],
  )
  const allOrgs = useMemo(
    () => [...new Set(entries.map((e) => orgNameOf(e, language)).filter(Boolean))].sort(),
    [entries, language],
  )

  const filtered = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    const result = entries.filter((e) => {
      if (typeFilter.length && !typeFilter.includes(e.type)) return false
      if (badgeFilter.length && !(e.badges ?? []).some((b) => badgeFilter.includes(b))) return false
      if (authorFilter.length && !(e.author?.name && authorFilter.includes(e.author.name))) return false
      if (orgFilter.length && !orgFilter.includes(orgNameOf(e, language))) return false
      if (!words.length) return true
      const haystack = [
        localized(e.name, language),
        localized(e.description, language),
        e.author?.name ?? '',
        orgNameOf(e, language),
        ...(e.badges ?? []),
      ].join(' ').toLowerCase()
      return words.every((w) => haystack.includes(w))
    })
    return applySort(result, sort, {
      name: (e) => localized(e.name, language),
      createdAt: (e) => e.createdAt ?? '',
      updatedAt: (e) => e.updatedAt ?? '',
    })
  }, [entries, searchQuery, typeFilter, badgeFilter, authorFilter, orgFilter, sort, language])

  const filterGroups: FilterGroup[] = [
    ...(lockedType
      ? []
      : [{
          key: 'type',
          label: t('catalog.filter_type'),
          options: ENTRY_TYPES.filter((ty) => entries.some((e) => e.type === ty))
            .map((ty) => ({
              value: ty,
              label: t(ENTRY_TYPE_META[ty].labelKey),
              icon: ENTRY_TYPE_META[ty].icon,
              iconClass: ENTRY_TYPE_META[ty].color,
            })),
          selected: typeFilter,
          onChange: setTypeFilter,
        } satisfies FilterGroup]),
    {
      key: 'badges',
      label: t('catalog.filter_badges'),
      options: allBadges.map((b) => ({ value: b, label: b })),
      selected: badgeFilter,
      onChange: setBadgeFilter,
    },
    {
      key: 'author',
      label: t('catalog.filter_author'),
      options: allAuthors.map((a) => ({ value: a, label: a })),
      selected: authorFilter,
      onChange: setAuthorFilter,
    },
    {
      key: 'organization',
      label: t('catalog.filter_organization'),
      options: allOrgs.map((o) => ({ value: o, label: o })),
      selected: orgFilter,
      onChange: setOrgFilter,
    },
  ]

  return (
    <div className={className}>
      {entries.length > 0 && (
        <ListPageToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchPlaceholder={t('common.search')}
          filterGroups={filterGroups}
          sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
        >
          {toolbarExtra}
        </ListPageToolbar>
      )}

      {filtered.length === 0 ? (
        <Card className="mt-6">
          <div className="flex flex-col items-center py-12">
            <p className="text-sm text-muted-foreground">
              {entries.length === 0
                ? (lockedType ? t('import_source.catalog_empty') : t('catalog.empty'))
                : t('common.no_results')}
            </p>
          </div>
        </Card>
      ) : (
        <div className={`mt-6 grid gap-3 ${gridClassName}`}>
          {filtered.map((entry) => (
            <CatalogEntryCard
              key={entry.id}
              entry={entry}
              language={language}
              onInstall={() => onInstall(entry)}
              busy={busyId === entry.id}
              onOpen={openInApp(entry)}
              serverMode={serverMode}
              hasWorkspace={hasWorkspace}
              installed={installed[entry.id]}
            />
          ))}
        </div>
      )}
    </div>
  )
}
