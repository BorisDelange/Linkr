import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Dashboard, FilterValue } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'

interface DashboardFilterSidebarProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  dashboard: Dashboard
}

export function DashboardFilterSidebar({ open, onOpenChange, dashboard }: DashboardFilterSidebarProps) {
  const { t } = useTranslation()
  const { activeFilters, setAllFilters } = useDashboardStore()
  const { files, getFileRows } = useDatasetStore()

  // Local deferred filter state
  const [localFilters, setLocalFilters] = useState<Record<string, FilterValue>>({})

  // Sync from store when sidebar opens
  useEffect(() => {
    if (open) {
      setLocalFilters({ ...activeFilters })
    }
  }, [open, activeFilters])

  const datasetFile = files.find((f) => f.id === dashboard.datasetFileId)
  const columns = datasetFile?.columns ?? []
  const rows = dashboard.datasetFileId ? getFileRows(dashboard.datasetFileId) : []

  const localFilterCount = Object.keys(localFilters).length

  const handleLocalFilterChange = (columnId: string, value: FilterValue) => {
    setLocalFilters(prev => ({ ...prev, [columnId]: value }))
  }

  const handleClearAll = () => {
    setLocalFilters({})
  }

  const handleApply = () => {
    setAllFilters(localFilters)
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" showCloseButton={false} className="w-80 p-0 flex flex-col">
        <SheetHeader className="px-4 py-3 border-b shrink-0">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-sm">{t('dashboard.filter_title')}</SheetTitle>
            <div className="flex items-center gap-1">
              {localFilterCount > 0 && (
                <Button variant="ghost" size="xs" onClick={handleClearAll}>
                  {t('dashboard.filter_clear_all')}
                </Button>
              )}
              <SheetClose asChild>
                <Button variant="ghost" size="icon-xs">
                  <X size={14} />
                </Button>
              </SheetClose>
            </div>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4 space-y-4">
            {dashboard.filterConfig.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('dashboard.filter_no_columns')}
              </p>
            ) : (
              dashboard.filterConfig.map((fc) => {
                const col = columns.find((c) => c.id === fc.columnId)
                const label = fc.label ?? col?.name ?? fc.columnId

                switch (fc.type) {
                  case 'categorical':
                    return (
                      <CategoricalFilter
                        key={fc.columnId}
                        label={label}
                        columnId={fc.columnId}
                        rows={rows}
                        value={localFilters[fc.columnId] as FilterValue & { type: 'categorical' } | undefined}
                        onChange={(v) => handleLocalFilterChange(fc.columnId, v)}
                      />
                    )
                  case 'numeric':
                    return (
                      <NumericFilter
                        key={fc.columnId}
                        label={label}
                        columnId={fc.columnId}
                        rows={rows}
                        value={localFilters[fc.columnId] as FilterValue & { type: 'numeric' } | undefined}
                        onChange={(v) => handleLocalFilterChange(fc.columnId, v)}
                      />
                    )
                  case 'date':
                    return (
                      <DateFilter
                        key={fc.columnId}
                        label={label}
                        columnId={fc.columnId}
                        value={localFilters[fc.columnId] as FilterValue & { type: 'date' } | undefined}
                        onChange={(v) => handleLocalFilterChange(fc.columnId, v)}
                      />
                    )
                  default:
                    return null
                }
              })
            )}
          </div>
        </ScrollArea>

        {dashboard.filterConfig.length > 0 && (
          <SheetFooter className="border-t px-4 py-3">
            <Button size="sm" className="w-full" onClick={handleApply}>
              {t('dashboard.filter_apply')}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}

// --- Categorical Filter ---

function CategoricalFilter({
  label,
  columnId,
  rows,
  value,
  onChange,
}: {
  label: string
  columnId: string
  rows: Record<string, unknown>[]
  value?: { type: 'categorical'; selected: string[] }
  onChange: (value: FilterValue) => void
}) {
  const uniqueValues = useMemo(() => {
    const vals = new Set<string>()
    for (const row of rows) {
      const v = row[columnId]
      if (v != null && v !== '') vals.add(String(v))
    }
    return Array.from(vals).sort()
  }, [rows, columnId])

  const selected = new Set(value?.selected ?? [])
  const allSelected = selected.size === 0

  const toggle = (val: string) => {
    const next = new Set(selected)
    if (next.has(val)) {
      next.delete(val)
    } else {
      next.add(val)
    }
    onChange({ type: 'categorical', selected: Array.from(next) })
  }

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <div className="space-y-1 max-h-40 overflow-y-auto">
        {uniqueValues.map((val) => (
          <label key={val} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent/50 rounded px-1 py-0.5">
            <input
              type="checkbox"
              checked={allSelected || selected.has(val)}
              onChange={() => toggle(val)}
              className="h-3 w-3 rounded border-input"
            />
            <span className="truncate">{val}</span>
          </label>
        ))}
        {uniqueValues.length === 0 && (
          <p className="text-xs text-muted-foreground italic">No values</p>
        )}
      </div>
      {selected.size > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="text-xs h-5"
          onClick={() => onChange({ type: 'categorical', selected: [] })}
        >
          <X size={10} />
          Clear
        </Button>
      )}
    </div>
  )
}

// --- Numeric Filter ---

function NumericFilter({
  label,
  columnId,
  rows,
  value,
  onChange,
}: {
  label: string
  columnId: string
  rows: Record<string, unknown>[]
  value?: { type: 'numeric'; min: number | null; max: number | null }
  onChange: (value: FilterValue) => void
}) {
  const range = useMemo(() => {
    let min = Infinity
    let max = -Infinity
    for (const row of rows) {
      const v = Number(row[columnId])
      if (!isNaN(v)) {
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 100 : max }
  }, [rows, columnId])

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-0.5">
          <span className="text-[10px] text-muted-foreground">Min ({range.min})</span>
          <Input
            type="number"
            className="h-7 text-xs"
            placeholder={String(range.min)}
            value={value?.min ?? ''}
            onChange={(e) => {
              const v = e.target.value === '' ? null : Number(e.target.value)
              onChange({ type: 'numeric', min: v, max: value?.max ?? null })
            }}
          />
        </div>
        <div className="space-y-0.5">
          <span className="text-[10px] text-muted-foreground">Max ({range.max})</span>
          <Input
            type="number"
            className="h-7 text-xs"
            placeholder={String(range.max)}
            value={value?.max ?? ''}
            onChange={(e) => {
              const v = e.target.value === '' ? null : Number(e.target.value)
              onChange({ type: 'numeric', min: value?.min ?? null, max: v })
            }}
          />
        </div>
      </div>
    </div>
  )
}

// --- Date Filter ---

function DateFilter({
  label,
  columnId: _columnId,
  value,
  onChange,
}: {
  label: string
  columnId: string
  value?: { type: 'date'; from: string | null; to: string | null }
  onChange: (value: FilterValue) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-0.5">
          <span className="text-[10px] text-muted-foreground">From</span>
          <Input
            type="date"
            className="h-7 text-xs"
            value={value?.from ?? ''}
            onChange={(e) => {
              onChange({ type: 'date', from: e.target.value || null, to: value?.to ?? null })
            }}
          />
        </div>
        <div className="space-y-0.5">
          <span className="text-[10px] text-muted-foreground">To</span>
          <Input
            type="date"
            className="h-7 text-xs"
            value={value?.to ?? ''}
            onChange={(e) => {
              onChange({ type: 'date', from: value?.from ?? null, to: e.target.value || null })
            }}
          />
        </div>
      </div>
    </div>
  )
}
