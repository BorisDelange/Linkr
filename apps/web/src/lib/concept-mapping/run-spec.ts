/**
 * What a server-owned concept run is given (apps/api schemas/concept_run.py):
 * its SQL compiled here, once, by the builders client-only mode runs itself —
 * the server fills in each batch's and each page's ids, and assembles the
 * profiles from the rows (services/concept_runs/profiles.py, a twin of this
 * folder's assembly).
 */

import type { SchemaMapping } from '@/types/schema-mapping'
import { exactOptions, sectionsOf } from '@/lib/concept-profiles/profile-store'
import { countedRelationSignature } from '@/features/projects/warehouse/concepts/concept-count-plan'
import {
  RUN_IDS,
  availableSections,
  buildBatchProfileQuery,
  effectiveSections,
  emptyScalar,
  localizedPresetLabel,
  type ProfileOptions,
  type ProfileSource,
} from './concept-profile'
import {
  buildConceptCountsQuery,
  buildDictionaryIdsQuery,
  buildDictionaryPageTemplate,
  computesCounts,
  computesMetadata,
  sortNeedsCounts,
  type ExtractionSort,
} from './source-extraction'

export interface RunEventSpec {
  relation: string
  signature: string | null
  countSql: string
  batchSql: string
  emptyScalar: Record<string, unknown>
  sections: string[]
}

export interface RunDictionarySpec {
  dictKey: string
  idsSql: string
  pageSql: string
  events: RunEventSpec[]
  sections: string[]
}

export interface RunCountSpec {
  runId: string
  steps: { step: 'records' | 'patients'; items: { key: string; sql: string }[] }[]
  finalAssembleSql: string
}

export interface RunSpec {
  label: string
  fingerprint: string
  options: ProfileOptions
  sort: ExtractionSort
  onlyWithRecords: boolean
  needsCounts: boolean
  metadata: boolean
  countColumns: boolean
  dataSourceLabel: string | null
  dictionaries: RunDictionarySpec[]
  counts: RunCountSpec | null
  extraction: { fileSourceData: Record<string, unknown>; dictionaryKeys: string[] } | null
  fresh: boolean
}

export interface RunSpecInput {
  label: string
  mapping: SchemaMapping
  sources: ProfileSource[]
  options: ProfileOptions
  sort: ExtractionSort
  onlyWithRecords: boolean
  fingerprint: string
  /** The SQL as the database runs it (`prepareQuerySql`): its class relations written in. */
  prepare: (sql: string) => Promise<string>
  counts?: RunCountSpec | null
  extraction?: RunSpec['extraction']
  fresh?: boolean
}

export async function buildRunSpec(input: RunSpecInput): Promise<RunSpec> {
  const { mapping, sources, options, sort, prepare } = input
  const metadata = computesMetadata(options)
  const dictionaries: RunDictionarySpec[] = []
  for (const source of sources) {
    const sections = effectiveSections(options.sections, availableSections(mapping, source))
    // What the store keeps: the exact profile, its readers' thresholds applied on reading.
    const exact = exactOptions(options, sections)
    const events: RunEventSpec[] = []
    for (const event of source.events) {
      const home = event === source.event ? source : { ...source, event }
      const homeSections = effectiveSections(exact.sections, availableSections(mapping, home))
      events.push({
        relation: event.name,
        signature: source.dictionary.ownId ? countedRelationSignature(event, source.dict) : null,
        countSql: await prepare(buildConceptCountsQuery(source, event)),
        batchSql: await prepare(buildBatchProfileQuery(mapping, home, RUN_IDS, homeSections, exact)),
        emptyScalar: emptyScalar(event, homeSections),
        sections: sectionsOf(homeSections),
      })
    }
    dictionaries.push({
      dictKey: source.dictionary.key,
      idsSql: await prepare(buildDictionaryIdsQuery(source, sort)),
      pageSql: await prepare(buildDictionaryPageTemplate(source)),
      events,
      sections: sectionsOf(sections),
    })
  }
  return {
    label: input.label,
    fingerprint: input.fingerprint,
    options,
    sort,
    onlyWithRecords: input.onlyWithRecords,
    needsCounts: input.onlyWithRecords
      || (metadata && (sortNeedsCounts(sort) || sources.some((s) => s.events.length > 1))),
    metadata,
    countColumns: computesCounts(options),
    dataSourceLabel: localizedPresetLabel(mapping) ?? null,
    dictionaries,
    counts: input.counts ?? null,
    extraction: input.extraction ?? null,
    fresh: !!input.fresh,
  }
}
