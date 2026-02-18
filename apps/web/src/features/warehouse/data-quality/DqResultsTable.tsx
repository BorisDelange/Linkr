import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { CATEGORY_COLORS, STATUS_CONFIG, SEVERITY_CONFIG } from './DqConstants'
import type { DqCheck, DqCheckResult, DqCheckStatus } from '@/lib/duckdb/data-quality'

export interface DqResultItem {
  check: DqCheck
  result: DqCheckResult
}

interface Props {
  items: DqResultItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  loading: boolean
}

type SortField = 'status' | 'check' | 'category' | 'table' | 'violated' | 'severity'
type SortDir = 'asc' | 'desc'

const STATUS_ORDER: Record<DqCheckStatus, number> = { fail: 0, error: 1, pass: 2, not_applicable: 3 }
const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, notice: 2 }

export function DqResultsTable({ items, selectedId, onSelect, loading }: Props) {
  const { t } = useTranslation()
  const [sortField, setSortField] = useState<SortField | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const sorted = useMemo(() => {
    if (!sortField) return items
    const dir = sortDir === 'asc' ? 1 : -1
    return [...items].sort((a, b) => {
      switch (sortField) {
        case 'status':
          return (STATUS_ORDER[a.result.status] - STATUS_ORDER[b.result.status]) * dir
        case 'check':
          return a.check.description.localeCompare(b.check.description) * dir
        case 'category':
          return a.check.category.localeCompare(b.check.category) * dir
        case 'table':
          return (a.check.tableName ?? '').localeCompare(b.check.tableName ?? '') * dir
        case 'violated':
          return (a.result.pctViolated - b.result.pctViolated) * dir
        case 'severity':
          return ((SEVERITY_ORDER[a.check.severity] ?? 9) - (SEVERITY_ORDER[b.check.severity] ?? 9)) * dir
        default:
          return 0
      }
    })
  }, [items, sortField, sortDir])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown size={10} className="text-muted-foreground/40" />
    return sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />
  }

  return (
    <ScrollArea className="h-full">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="border-b">
            <th
              className="w-10 cursor-pointer select-none px-2 py-2 text-center font-medium"
              onClick={() => handleSort('status')}
            >
              <span className="inline-flex items-center gap-0.5">
                {t('data_quality.col_status')} <SortIcon field="status" />
              </span>
            </th>
            <th
              className="cursor-pointer select-none px-2 py-2 text-left font-medium"
              onClick={() => handleSort('check')}
            >
              <span className="inline-flex items-center gap-0.5">
                {t('data_quality.col_check')} <SortIcon field="check" />
              </span>
            </th>
            <th
              className="cursor-pointer select-none px-2 py-2 text-left font-medium"
              onClick={() => handleSort('category')}
            >
              <span className="inline-flex items-center gap-0.5">
                {t('data_quality.col_category')} <SortIcon field="category" />
              </span>
            </th>
            <th
              className="cursor-pointer select-none px-2 py-2 text-left font-medium"
              onClick={() => handleSort('table')}
            >
              <span className="inline-flex items-center gap-0.5">
                {t('data_quality.col_table')} <SortIcon field="table" />
              </span>
            </th>
            <th
              className="cursor-pointer select-none px-2 py-2 text-right font-medium"
              onClick={() => handleSort('violated')}
            >
              <span className="inline-flex items-center gap-0.5">
                {t('data_quality.col_violated')} <SortIcon field="violated" />
              </span>
            </th>
            <th
              className="w-10 cursor-pointer select-none px-2 py-2 text-center font-medium"
              onClick={() => handleSort('severity')}
            >
              <span className="inline-flex items-center gap-0.5">
                {t('data_quality.col_severity')} <SortIcon field="severity" />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(({ check, result }) => {
            const statusCfg = STATUS_CONFIG[result.status]
            const StatusIcon = statusCfg.icon
            const sevCfg = SEVERITY_CONFIG[check.severity]
            const SevIcon = sevCfg.icon
            const isActive = check.id === selectedId

            return (
              <tr
                key={check.id}
                onClick={() => onSelect(check.id)}
                className={cn(
                  'cursor-pointer border-b transition-colors last:border-0',
                  isActive ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <td className="px-2 py-1.5 text-center">
                  <StatusIcon size={14} className={statusCfg.color} />
                </td>
                <td className="max-w-[200px] truncate px-2 py-1.5">
                  <span className="font-medium">{check.description}</span>
                </td>
                <td className="px-2 py-1.5">
                  <span className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-medium', CATEGORY_COLORS[check.category])}>
                    {t(`data_quality.category_${check.category}`)}
                  </span>
                </td>
                <td className="px-2 py-1.5 font-mono text-muted-foreground">
                  {check.tableName ?? '—'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {result.status === 'not_applicable' ? '—' : `${result.pctViolated.toFixed(1)}%`}
                </td>
                <td className="px-2 py-1.5 text-center">
                  <SevIcon size={14} className={sevCfg.color} />
                </td>
              </tr>
            )
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                {t('data_quality.no_results')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </ScrollArea>
  )
}
