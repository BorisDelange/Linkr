import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { usePatientChartContext } from './PatientChartContext'
import { queryDataSource } from '@/lib/duckdb/engine'
import { getDefaultConceptDictionary } from '@/lib/schema-helpers'

interface ConceptPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedConceptIds: number[]
  eventTableLabel: string
  onConfirm: (conceptIds: number[], eventTableLabel: string) => void
}

interface ConceptRow {
  concept_id: number
  concept_name: string
}

export function ConceptPickerDialog({
  open,
  onOpenChange,
  selectedConceptIds,
  eventTableLabel,
  onConfirm,
}: ConceptPickerDialogProps) {
  const { t } = useTranslation()
  const { dataSourceId, schemaMapping } = usePatientChartContext()

  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [currentLabel, setCurrentLabel] = useState(eventTableLabel)
  const [concepts, setConcepts] = useState<ConceptRow[]>([])
  const [loading, setLoading] = useState(false)

  // Available event table labels
  const eventLabels = useMemo(
    () =>
      schemaMapping?.eventTables
        ? Object.keys(schemaMapping.eventTables)
        : [],
    [schemaMapping],
  )

  // Sync from props when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(selectedConceptIds))
      setCurrentLabel(eventTableLabel || eventLabels[0] || '')
      setSearch('')
    }
  }, [open, selectedConceptIds, eventTableLabel, eventLabels])

  // Search concepts in concept dictionary
  useEffect(() => {
    if (!open || !dataSourceId || !schemaMapping) return

    const dict = getDefaultConceptDictionary(schemaMapping)
    if (!dict) {
      setConcepts([])
      return
    }

    let cancelled = false
    setLoading(true)

    const searchFilter = search.trim()
      ? `WHERE LOWER("${dict.nameColumn}") LIKE '%${search.trim().toLowerCase().replace(/'/g, "''")}%'`
      : ''

    const sql = `SELECT "${dict.idColumn}" AS concept_id, "${dict.nameColumn}" AS concept_name
FROM "${dict.table}"
${searchFilter}
ORDER BY "${dict.nameColumn}"
LIMIT 100`

    queryDataSource(dataSourceId, sql)
      .then((rows) => {
        if (!cancelled) setConcepts((rows as ConceptRow[]) ?? [])
      })
      .catch(() => {
        if (!cancelled) setConcepts([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, dataSourceId, schemaMapping, search])

  const toggleConcept = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleConfirm = () => {
    onConfirm([...selectedIds], currentLabel)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('patient_data.select_concepts')}</DialogTitle>
        </DialogHeader>

        {/* Event table selector */}
        {eventLabels.length > 1 && (
          <div className="mb-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t('patient_data.event_table')}
            </label>
            <Select value={currentLabel} onValueChange={setCurrentLabel}>
              <SelectTrigger className="mt-1 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {eventLabels.map((label) => (
                  <SelectItem key={label} value={label}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Search */}
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('patient_data.search_concepts')}
            className="h-8 pl-8 text-xs"
          />
        </div>

        {/* Selection count */}
        <p className="text-xs text-muted-foreground">
          {t('patient_data.concepts_selected', { count: selectedIds.size })}
        </p>

        {/* Concept list */}
        <ScrollArea className="h-64 rounded-md border">
          {loading ? (
            <div className="flex h-full items-center justify-center py-8">
              <p className="text-xs text-muted-foreground">
                {t('common.loading')}
              </p>
            </div>
          ) : concepts.length === 0 ? (
            <div className="flex h-full items-center justify-center py-8">
              <p className="text-xs text-muted-foreground">
                {t('patient_data.no_concepts_found')}
              </p>
            </div>
          ) : (
            <div className="p-1">
              {concepts.map((c) => {
                const isSelected = selectedIds.has(Number(c.concept_id))
                return (
                  <button
                    key={c.concept_id}
                    onClick={() => toggleConcept(Number(c.concept_id))}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                      isSelected
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-accent/50',
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-muted-foreground/30',
                      )}
                    >
                      {isSelected && <Check size={10} />}
                    </div>
                    <span className="truncate">{c.concept_name}</span>
                    <span className="ml-auto shrink-0 font-mono text-muted-foreground">
                      {c.concept_id}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleConfirm}>
            {t('common.confirm')} ({selectedIds.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
