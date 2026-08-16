import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { columnLabel } from '@/lib/format-helpers'
import { StandardConceptBadge } from '@/lib/concept-mapping/standard-concept-badge'
import { ConceptStatsPanel } from './ConceptStatsPanel'
import type { ConceptStats } from './use-concepts'
import type { ColumnDescriptor } from './concept-queries'

interface ConceptDetailProps {
  concept: Record<string, unknown> | null
  availableColumns: ColumnDescriptor[]
  stats: ConceptStats | null
  statsLoading: boolean
  hasValueColumn: boolean
  excludeOutliers: boolean
  statsEnabled: boolean
}

function MetaRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start justify-between gap-2 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right text-xs font-medium">{value || '—'}</span>
    </div>
  )
}

export function ConceptDetail({
  concept,
  availableColumns,
  stats,
  statsLoading,
  hasValueColumn,
  excludeOutliers,
  statsEnabled,
}: ConceptDetailProps) {
  const { t } = useTranslation()

  // Metadata rows follow the table's column order (concept_id included — it is
  // the field most often copied out of here); the name is already the heading.
  const metaColumns = useMemo(() => {
    return availableColumns.filter((c) => c.id !== 'concept_name' && c.source !== 'computed')
  }, [availableColumns])

  if (!concept) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('concepts.select_concept')}</p>
      </div>
    )
  }

  const conceptName = String(concept.concept_name ?? '')
  // The id column is aliased from the mapping's idColumn; a mis-mapped or text id
  // yields NaN — don't render "#NaN", just show the raw value (or nothing).
  const rawId = concept.concept_id
  const numericId = Number(rawId)
  const conceptIdLabel =
    rawId == null || rawId === ''
      ? null
      : Number.isFinite(numericId)
        ? String(numericId)
        : String(rawId)
  const conceptCode = concept.concept_code != null && concept.concept_code !== ''
    ? String(concept.concept_code)
    : null
  const vocabularyId = concept.vocabulary_id ? String(concept.vocabulary_id) : null
  const dictKey = concept._dict_key ? String(concept._dict_key) : null

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        {/* Header — same shape as the mapping editor's concept detail: name plus
            a code badge on the first line, vocabulary on the second. */}
        <div>
          <div className="flex items-start gap-2">
            <span className="min-w-0 break-words text-sm font-semibold leading-tight">
              {conceptName || conceptIdLabel || t('concepts.unnamed_concept')}
            </span>
            {conceptCode && (
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                {conceptCode}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            {vocabularyId && <span>{vocabularyId}</span>}
            {dictKey && <span>· {dictKey}</span>}
          </div>
        </div>

        <Separator />

        {/* Metadata — dynamic from availableColumns */}
        <div>
          <h4 className="text-xs font-medium">{t('concepts.detail_title')}</h4>
          <div className="mt-1">
            {metaColumns.map((col) => {
              const raw = concept[col.id]
              // standard_concept reads as the same S/C/NS badge as the table —
              // and NULL is meaningful there (non-standard), so it always shows.
              if (col.id === 'standard_concept') {
                return (
                  <div key={col.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="text-xs text-muted-foreground">{columnLabel(col.id)}</span>
                    <StandardConceptBadge value={raw == null ? null : String(raw)} />
                  </div>
                )
              }
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
          excludeOutliers={excludeOutliers}
          statsEnabled={statsEnabled}
        />
      </div>
    </ScrollArea>
  )
}
