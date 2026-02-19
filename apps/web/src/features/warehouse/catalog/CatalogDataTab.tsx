import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, ArrowUpDown } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { DataCatalog, CatalogResultCache, CatalogResultRow } from '@/types'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
}

type SortKey = 'conceptName' | 'patientCount' | 'recordCount' | string

export function CatalogDataTab({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('patientCount')
  const [sortDesc, setSortDesc] = useState(true)
  const [page, setPage] = useState(0)
  const pageSize = 50

  const enabledDims = useMemo(
    () => catalog.dimensions.filter((d) => d.enabled),
    [catalog.dimensions],
  )

  const hasCategory = !!catalog.categoryColumn
  const hasSubcategory = !!catalog.subcategoryColumn

  // Filter + sort rows
  const filteredRows = useMemo(() => {
    let rows = cache.rows
    if (search.trim()) {
      const q = search.toLowerCase()
      rows = rows.filter(
        (r) =>
          r.conceptName.toLowerCase().includes(q) ||
          String(r.conceptId).includes(q) ||
          (r.category && r.category.toLowerCase().includes(q)) ||
          (r.subcategory && r.subcategory.toLowerCase().includes(q)),
      )
    }

    // Sort
    rows = [...rows].sort((a, b) => {
      let aVal: string | number | null
      let bVal: string | number | null

      if (sortKey === 'conceptName') {
        aVal = a.conceptName
        bVal = b.conceptName
      } else if (sortKey === 'category') {
        aVal = a.category ?? null
        bVal = b.category ?? null
      } else if (sortKey === 'subcategory') {
        aVal = a.subcategory ?? null
        bVal = b.subcategory ?? null
      } else if (sortKey === 'patientCount') {
        aVal = a.patientCount
        bVal = b.patientCount
      } else if (sortKey === 'recordCount') {
        aVal = a.recordCount
        bVal = b.recordCount
      } else {
        aVal = a.dimensions[sortKey] ?? null
        bVal = b.dimensions[sortKey] ?? null
      }

      if (aVal == null && bVal == null) return 0
      if (aVal == null) return 1
      if (bVal == null) return -1

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDesc ? bVal - aVal : aVal - bVal
      }

      const cmp = String(aVal).localeCompare(String(bVal))
      return sortDesc ? -cmp : cmp
    })

    return rows
  }, [cache.rows, search, sortKey, sortDesc])

  const totalPages = Math.ceil(filteredRows.length / pageSize)
  const pageRows = filteredRows.slice(page * pageSize, (page + 1) * pageSize)

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc(!sortDesc)
    } else {
      setSortKey(key)
      setSortDesc(true)
    }
    setPage(0)
  }

  const SortButton = ({ colKey, children }: { colKey: SortKey; children: React.ReactNode }) => (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-7 text-xs font-medium"
      onClick={() => handleSort(colKey)}
    >
      {children}
      <ArrowUpDown size={12} className="ml-1" />
    </Button>
  )

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="flex gap-3">
        <Card className="flex-1 p-3 text-center">
          <p className="text-2xl font-bold">{cache.totalConcepts.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{t('data_catalog.total_concepts')}</p>
        </Card>
        <Card className="flex-1 p-3 text-center">
          <p className="text-2xl font-bold">{cache.totalPatients.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{t('data_catalog.total_patients')}</p>
        </Card>
        <Card className="flex-1 p-3 text-center">
          <p className="text-2xl font-bold">{cache.rows.length.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{t('data_catalog.total_rows')}</p>
        </Card>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search size={14} className="absolute left-2.5 top-2.5 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0) }}
          placeholder={t('data_catalog.search_concepts')}
          className="pl-8"
        />
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">
                <SortButton colKey="conceptId">{t('data_catalog.col_concept_id')}</SortButton>
              </TableHead>
              <TableHead>
                <SortButton colKey="conceptName">{t('data_catalog.col_concept_name')}</SortButton>
              </TableHead>
              {hasCategory && (
                <TableHead>
                  <SortButton colKey="category">{t('data_catalog.col_category')}</SortButton>
                </TableHead>
              )}
              {hasSubcategory && (
                <TableHead>
                  <SortButton colKey="subcategory">{t('data_catalog.col_subcategory')}</SortButton>
                </TableHead>
              )}
              {enabledDims.map((dim) => (
                <TableHead key={dim.id}>
                  <SortButton colKey={dim.id}>{t(`data_catalog.dim_${dim.type}`)}</SortButton>
                </TableHead>
              ))}
              <TableHead className="w-28 text-right">
                <SortButton colKey="patientCount">{t('data_catalog.col_patients')}</SortButton>
              </TableHead>
              <TableHead className="w-28 text-right">
                <SortButton colKey="recordCount">{t('data_catalog.col_records')}</SortButton>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4 + enabledDims.length + (hasCategory ? 1 : 0) + (hasSubcategory ? 1 : 0)} className="py-8 text-center text-sm text-muted-foreground">
                  {t('data_catalog.no_results')}
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((row, i) => (
                <TableRow key={`${row.conceptId}-${i}`}>
                  <TableCell className="font-mono text-xs">{row.conceptId}</TableCell>
                  <TableCell className="text-sm">{row.conceptName}</TableCell>
                  {hasCategory && (
                    <TableCell className="text-xs">{row.category ?? '—'}</TableCell>
                  )}
                  {hasSubcategory && (
                    <TableCell className="text-xs">{row.subcategory ?? '—'}</TableCell>
                  )}
                  {enabledDims.map((dim) => (
                    <TableCell key={dim.id} className="text-xs">
                      {row.dimensions[dim.id] ?? '—'}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-mono text-xs">
                    {row.patientCount.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {row.recordCount.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {t('data_catalog.showing_rows', {
              from: page * pageSize + 1,
              to: Math.min((page + 1) * pageSize, filteredRows.length),
              total: filteredRows.length,
            })}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              {t('common.back')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage(page + 1)}
            >
              {t('data_catalog.next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
