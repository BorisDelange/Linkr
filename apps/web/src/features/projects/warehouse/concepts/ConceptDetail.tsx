import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { ConceptStatsPanel } from './ConceptStatsPanel'
import type { ConceptStats } from './use-concepts'
import type { ColumnDescriptor } from './concept-queries'

interface ConceptDetailProps {
  concept: Record<string, unknown> | null
  availableColumns: ColumnDescriptor[]
  stats: ConceptStats | null
  statsLoading: boolean
  hasValueColumn: boolean
}

function MetaRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start justify-between gap-2 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right text-xs font-medium">{value || '—'}</span>
    </div>
  )
}

/** Capitalize a snake_case key into a display label. */
function columnLabel(id: string): string {
  return id
    .replace(/^_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function ConceptDetail({ concept, availableColumns, stats, statsLoading, hasValueColumn }: ConceptDetailProps) {
  const { t } = useTranslation()

  // Metadata columns: everything except id, name, and computed columns
  const metaColumns = useMemo(() => {
    return availableColumns.filter(
      (c) => c.id !== 'concept_id' && c.id !== 'concept_name' && c.source !== 'computed',
    )
  }, [availableColumns])

  if (!concept) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('concepts.select_concept')}</p>
      </div>
    )
  }

  const conceptName = String(concept.concept_name ?? '')
  const conceptId = Number(concept.concept_id)
  const vocabularyId = concept.vocabulary_id ? String(concept.vocabulary_id) : null
  const dictKey = concept._dict_key ? String(concept._dict_key) : null

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        {/* Header */}
        <div>
          <h3 className="break-words text-sm font-semibold leading-tight">{conceptName}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs text-muted-foreground">#{conceptId}</span>
            {vocabularyId && <Badge variant="outline" className="text-[10px]">{vocabularyId}</Badge>}
            {dictKey && <Badge variant="secondary" className="text-[10px]">{dictKey}</Badge>}
          </div>
        </div>

        <Separator />

        {/* Metadata — dynamic from availableColumns */}
        <div>
          <h4 className="text-xs font-medium">{t('concepts.detail_title')}</h4>
          <div className="mt-1">
            {metaColumns.map((col) => {
              const raw = concept[col.id]
              const value = raw != null ? String(raw) : null
              return <MetaRow key={col.id} label={columnLabel(col.id)} value={value} />
            })}

            {/* Show all extra fields from SELECT * that are not in availableColumns */}
            {Object.entries(concept).map(([key, val]) => {
              // Skip fields already handled above
              if (key === 'concept_id' || key === 'concept_name') return null
              if (availableColumns.some((c) => c.id === key)) return null
              if (val == null) return null
              return <MetaRow key={key} label={columnLabel(key)} value={String(val)} />
            })}
          </div>
        </div>

        <Separator />

        {/* Stats */}
        <ConceptStatsPanel
          hasValueColumn={hasValueColumn}
          stats={stats}
          isLoading={statsLoading}
        />
      </div>
    </ScrollArea>
  )
}
