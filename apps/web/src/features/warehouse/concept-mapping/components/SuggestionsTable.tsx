import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Info, Library } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { TruncatedText } from '@/components/ui/truncated-text'
import { StandardConceptBadge } from '@/lib/concept-mapping/standard-concept-badge'
import { ValidityBadge } from '@/lib/concept-mapping/validity-badge'
import { Badge } from '@/components/ui/badge'
import { EQUIV_BADGE } from '@/lib/concept-mapping/equivalence-badge'
import { type SuggestionCandidate, METHOD_DOT_COLORS, getMethodLabel, computeCombinedScore } from '@/lib/concept-mapping/syntactic-suggestions'

interface SuggestionsTableProps {
  suggestions: SuggestionCandidate[]
  weights: Record<string, number>
  alreadyMappedIds: Set<number>
  selectedConceptId: number | null
  onSelect: (s: SuggestionCandidate | null) => void
  onInfo: (s: SuggestionCandidate) => void
  /** Open the source data-dictionary concept set for an AI suggestion. */
  onConceptSet: (s: SuggestionCandidate) => void
  /** uniqueId → concept set name, for concept sets present locally. */
  conceptSetNamesByUid: Map<string, string>
}

/** Sort, filters, column widths and visibility used to be lifted into
 *  TargetConceptPanel, purely so they survived this table unmounting while the
 *  suggestions reloaded on a source-concept change. The shared table's view
 *  cache has the same lifetime (a remount, not a reload) and covers more, so the
 *  key replaces that plumbing. */
const VIEW_KEY = 'concept-mapping.suggestions'

export function SuggestionsTable({ suggestions, weights, alreadyMappedIds, selectedConceptId, onSelect, onInfo, onConceptSet, conceptSetNamesByUid }: SuggestionsTableProps) {
  const { t } = useTranslation()
  // A row carries several providers and matches when ANY picked one is among
  // them, which no per-value column filter can express — so this one filter is
  // applied here, and only its control is placed under the header.
  const [providers, setProviders] = useState<Set<string>>(new Set())

  const providerOptions = useMemo(
    () => [...new Set(suggestions.flatMap((s) => s.scores.map((sc) => sc.provider)))].sort(),
    [suggestions],
  )

  const reweighted = useMemo(() =>
    suggestions.map((s) => ({
      ...s,
      scores: s.scores.map((sc) => ({ ...sc, weight: weights[sc.provider] ?? sc.weight })),
      combined_score: computeCombinedScore(s.scores, weights),
    })),
  [suggestions, weights])

  const rows = useMemo(
    () => (providers.size
      ? reweighted.filter((s) => s.scores.some((sc) => providers.has(sc.provider)))
      : reweighted),
    [reweighted, providers],
  )

  const columns = useMemo<ConceptColumn<SuggestionCandidate>[]>(() => [
    {
      id: 'combined_score',
      header: t('concept_mapping.suggestions_col_score'),
      accessor: (r) => r.combined_score,
      cell: (r) => {
        const pct = Math.round(r.combined_score * 100)
        return (
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-8 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
          </div>
        )
      },
      size: 80,
      minSize: 60,
    },
    {
      id: 'methods',
      header: t('concept_mapping.suggestions_col_provider'),
      // No value of its own to sort on: the cell is a row of per-method dots.
      accessor: () => '',
      sortable: false,
      cell: (r) => (
        <div className="flex items-center gap-1.5">
          {r.scores.map(({ provider, method, score, comment }) => {
            const pct = Math.round(score * 100)
            const dot = METHOD_DOT_COLORS[provider] ?? 'bg-gray-400'
            const label = getMethodLabel(method)
            return (
              <Tooltip key={method}>
                <TooltipTrigger asChild>
                  <span className="inline-flex cursor-default items-center gap-0.5">
                    <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} />
                    <span className="text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs space-y-0.5 text-xs">
                  <p className="font-medium">{provider}</p>
                  <p className="text-muted-foreground">{label}</p>
                  <p>{pct}%</p>
                  {comment && <p className="mt-1.5 border-t pt-1.5 italic text-muted-foreground">{comment}</p>}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      ),
      filterCell: providerOptions.length > 1
        ? () => (
          <MultiSelectFilter
            value={[...providers]}
            options={providerOptions}
            placeholder="Méthode"
            onChange={(v) => setProviders(new Set(v))}
          />
        )
        : undefined,
      size: 70,
      minSize: 50,
    },
    {
      id: 'vocabulary_id',
      header: t('concept_mapping.col_vocabulary'),
      accessor: (r) => r.vocabulary_id,
      cell: (r) =>
        r.vocabulary_id
          ? <TruncatedText text={r.vocabulary_id} className="text-xs" />
          : <span className="text-xs italic text-muted-foreground/60">—</span>,
      filter: 'select',
      size: 80,
      minSize: 50,
    },
    {
      id: 'concept_id',
      header: t('concept_mapping.col_concept_id'),
      accessor: (r) => r.concept_id,
      filter: 'number',
      tooltip: 'font-mono text-xs',
      hidden: true,
      size: 70,
      minSize: 50,
    },
    {
      id: 'concept_name',
      header: t('concept_mapping.col_name'),
      accessor: (r) => r.concept_name,
      cell: (r) =>
        r.concept_name
          ? <TruncatedText text={r.concept_name} className="text-xs" />
          : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block truncate text-xs italic text-muted-foreground/60">
                  {t('concept_mapping.suggestions_concept_not_found')}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                {t('concept_mapping.suggestions_concept_not_found_hint')}
              </TooltipContent>
            </Tooltip>
          ),
      filter: 'text',
      size: 180,
      minSize: 100,
    },
    {
      id: 'concept_code',
      header: t('concept_mapping.col_concept_code'),
      accessor: (r) => r.concept_code,
      filter: 'text',
      tooltip: 'font-mono text-xs',
      hidden: true,
      size: 80,
      minSize: 50,
    },
    {
      id: 'domain_id',
      header: t('concept_mapping.col_domain'),
      accessor: (r) => r.domain_id,
      filter: 'select',
      hidden: true,
      size: 80,
      minSize: 50,
    },
    {
      id: 'concept_class_id',
      header: t('concept_mapping.col_concept_class'),
      accessor: (r) => r.concept_class_id,
      filter: 'select',
      hidden: true,
      size: 90,
      minSize: 50,
    },
    {
      id: 'standard_concept',
      header: t('concept_mapping.col_std'),
      accessor: (r) => r.standard_concept,
      // A not-found concept (OHDSI vocab not imported → no concept_name) has no
      // known standard flag; show nothing rather than a misleading "NS".
      cell: (r) => (r.concept_name ? <StandardConceptBadge value={r.standard_concept} /> : null),
      filter: 'select',
      size: 40,
      minSize: 30,
    },
    {
      id: 'valid',
      header: t('concept_mapping.col_valid'),
      accessor: (r) => r.invalid_reason ?? '',
      cell: (r) => (r.concept_name ? <ValidityBadge value={r.invalid_reason} /> : null),
      filter: 'none',
      hidden: true,
      size: 40,
      minSize: 30,
    },
    {
      id: 'equivalence',
      header: t('concept_mapping.col_equivalence'),
      accessor: (r) => r.equivalence,
      cell: (r) => {
        const eq = r.equivalence ?? 'skos:exactMatch'
        const badge = EQUIV_BADGE[eq]
        if (!badge) return <span className="text-[10px] text-muted-foreground">{eq}</span>
        return (
          <Badge variant="secondary" className={`px-1.5 py-0 text-[9px] font-medium ${badge.className}`} title={eq}>
            {badge.label}
          </Badge>
        )
      },
      filter: 'none',
      size: 70,
      minSize: 50,
    },
    {
      id: 'comment',
      header: t('concept_mapping.col_comment'),
      accessor: (r) => r.comment ?? '',
      filter: 'none',
      tooltip: 'text-[10px] text-muted-foreground',
      hidden: true,
      size: 180,
      minSize: 80,
    },
    {
      id: 'concept_set',
      header: t('concept_mapping.col_concept_set'),
      accessor: (r) => (r.conceptSetUid ? (conceptSetNamesByUid.get(r.conceptSetUid) ?? r.conceptSetUid) : ''),
      cell: (r) => {
        const uid = r.conceptSetUid
        if (!uid) return <span className="text-[10px] text-muted-foreground">—</span>
        const localName = conceptSetNamesByUid.get(uid)
        const label = localName ?? t('concept_mapping.cs_not_local')
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); onConceptSet(r) }}
              >
                <Library size={11} className="shrink-0" />
                <span className={`truncate ${localName ? '' : 'italic'}`}>{label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">
              {localName ? t('concept_mapping.cs_open_detail') : t('concept_mapping.cs_not_local_hint')}
            </TooltipContent>
          </Tooltip>
        )
      },
      filter: 'none',
      hidden: true,
      size: 150,
      minSize: 60,
    },
    {
      id: '_actions',
      header: '',
      accessor: () => '',
      sortable: false,
      resizable: false,
      cell: (r) => (
        <div className="flex items-center justify-end gap-0.5">
          {alreadyMappedIds.has(r.concept_id) && <Check size={11} className="text-green-600 shrink-0" />}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); onInfo(r) }}
              >
                <Info size={11} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">{t('concept_mapping.concept_info_btn')}</TooltipContent>
          </Tooltip>
        </div>
      ),
      filter: 'none',
      size: 48,
      minSize: 48,
    },
  ], [t, alreadyMappedIds, onInfo, onConceptSet, conceptSetNamesByUid, providerOptions, providers])

  return (
    <ConceptDataTable
      pageSize={100}
      data={rows}
      columns={columns}
      rowKey={(r) => r.concept_id}
      selectedRowKey={selectedConceptId}
      initialSorting={{ columnId: 'combined_score', desc: true }}
      cellTooltips="readOnly"
      viewKey={VIEW_KEY}
      rowClassName={(r) =>
        alreadyMappedIds.has(r.concept_id) && selectedConceptId !== r.concept_id
          ? 'opacity-40'
          : undefined}
      onRowClick={(r) => onSelect(selectedConceptId === r.concept_id ? null : r)}
    />
  )
}
