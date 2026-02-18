import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { CATEGORIES, SEVERITIES, STATUSES, SEVERITY_CONFIG, type DqFilters } from './DqConstants'
import type { DqCategory, DqSeverity, DqCheckStatus, DqReport } from '@/lib/duckdb/data-quality'

interface Props {
  filters: DqFilters
  onFiltersChange: (f: DqFilters) => void
  report: DqReport | null
}

export function DqFiltersPanel({ filters, onFiltersChange, report }: Props) {
  const { t } = useTranslation()

  // Extract unique table names from report
  const allTables = useMemo(() => {
    if (!report) return []
    const set = new Set<string>()
    for (const c of report.checks) {
      if (c.tableName) set.add(c.tableName)
    }
    return [...set].sort()
  }, [report])

  function toggleStatus(s: DqCheckStatus) {
    const next = new Set(filters.statuses)
    next.has(s) ? next.delete(s) : next.add(s)
    onFiltersChange({ ...filters, statuses: next })
  }

  function toggleCategory(c: DqCategory) {
    const next = new Set(filters.categories)
    next.has(c) ? next.delete(c) : next.add(c)
    onFiltersChange({ ...filters, categories: next })
  }

  function toggleTable(tbl: string) {
    const next = new Set(filters.tables)
    next.has(tbl) ? next.delete(tbl) : next.add(tbl)
    onFiltersChange({ ...filters, tables: next })
  }

  function toggleSeverity(s: DqSeverity) {
    const next = new Set(filters.severities)
    next.has(s) ? next.delete(s) : next.add(s)
    onFiltersChange({ ...filters, severities: next })
  }

  return (
    <div className="flex h-full flex-col border-r">
      {/* Search */}
      <div className="border-b px-2 py-1.5">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.searchText}
            onChange={(e) => onFiltersChange({ ...filters, searchText: e.target.value })}
            placeholder={t('common.search')}
            className="h-6 border-0 bg-accent/50 pl-6 text-xs shadow-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-4 p-3">
          {/* Filters ordered to match table columns: Status, Category, Table, Severity */}
          <FilterSection title={t('data_quality.filter_status')}>
            {STATUSES.map((s) => (
              <FilterCheckbox
                key={s}
                label={t(`data_quality.status_${s}`)}
                checked={filters.statuses.has(s)}
                onChange={() => toggleStatus(s)}
              />
            ))}
          </FilterSection>

          <FilterSection title={t('data_quality.filter_category')}>
            {CATEGORIES.map((c) => {
              const count = report?.summary.byCategory[c]
              return (
                <FilterCheckbox
                  key={c}
                  label={t(`data_quality.category_${c}`)}
                  checked={filters.categories.has(c)}
                  onChange={() => toggleCategory(c)}
                  badge={count ? `${count.failed}` : undefined}
                  badgeColor={count && count.failed > 0 ? 'text-red-600 dark:text-red-400' : undefined}
                />
              )
            })}
          </FilterSection>

          {allTables.length > 0 && (
            <FilterSection title={t('data_quality.filter_table')}>
              {allTables.map((tbl) => (
                <FilterCheckbox
                  key={tbl}
                  label={tbl}
                  checked={filters.tables.size === 0 || filters.tables.has(tbl)}
                  onChange={() => toggleTable(tbl)}
                />
              ))}
            </FilterSection>
          )}

          <FilterSection title={t('data_quality.filter_severity')}>
            {SEVERITIES.map((s) => {
              const cfg = SEVERITY_CONFIG[s]
              const count = report?.summary.bySeverity[s]
              return (
                <FilterCheckbox
                  key={s}
                  label={t(`data_quality.severity_${s}`)}
                  checked={filters.severities.has(s)}
                  onChange={() => toggleSeverity(s)}
                  badge={count ? `${count.failed}` : undefined}
                  badgeColor={count && count.failed > 0 ? cfg.color : undefined}
                />
              )
            })}
          </FilterSection>
        </div>
      </ScrollArea>
    </div>
  )
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {title}
      </button>
      {open && <div className="mt-1.5 space-y-0.5">{children}</div>}
    </div>
  )
}

function FilterCheckbox({
  label,
  checked,
  onChange,
  badge,
  badgeColor,
}: {
  label: string
  checked: boolean
  onChange: () => void
  badge?: string
  badgeColor?: string
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent/50">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3 w-3 rounded border-muted-foreground/30"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge && badge !== '0' && (
        <span className={cn('text-[10px] tabular-nums', badgeColor ?? 'text-muted-foreground')}>{badge}</span>
      )}
    </label>
  )
}
